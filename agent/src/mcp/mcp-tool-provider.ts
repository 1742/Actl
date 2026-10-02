import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Logger } from "../observability/logger.js";
import type { ExternalToolDefinition, ToolCallContext, ToolPermissionRequirement, ToolProvider } from "../tools/registry.js";
import type { McpServerConfig } from "./mcp-config.js";

export class McpToolProvider implements ToolProvider {
  readonly name: string;
  private client: Client | null = null;
  private tools = new Map<string, Tool>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private connectionError: string | null = null;
  private retryAfter = 0;
  private readonly instanceId = randomUUID();
  private activeCalls = 0;
  private retired = false;
  private readonly idleResolvers: Array<() => void> = [];
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly homeDirectory: string,
    private readonly logger: Logger,
  ) {
    this.name = `mcp-${serverName}`;
  }

  get status(): { name: string; connected: boolean; tools: number; error: string | null } {
    return { 
      name: this.serverName, 
      connected: this.client !== null, 
      tools: this.tools.size, 
      error: this.connectionError 
    };
  }

  get toolDetails(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((tool) => ({
      name: publicToolName(this.serverName, tool.name),
      description: tool.description ?? "",
    }));
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error(`MCP server ${this.serverName} is closed.`);
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open();
    try { 
      await this.connecting; 
    } finally { 
      this.connecting = null; 
    }
  }

  private async open(): Promise<void> {
    const client = new Client({ name: "actl", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd ? path.resolve(this.homeDirectory, this.config.cwd) : this.homeDirectory,
      ...(this.config.env ? { env: { ...getDefaultEnvironment(), ...this.config.env } } : {}),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.logger.info({ 
        event: "mcp.server.stderr", 
        server: this.serverName, 
        message: String(chunk).trim().slice(0, 2000) 
      });
    });
    client.onclose = () => {
      if (this.client === client) {
        this.client = null;
        this.tools.clear();
        this.connectionError = "Connection closed";
        this.retryAfter = Date.now() + 15_000;
      }
    };
    try {
      await client.connect(transport, { timeout: 10_000 });
      const tools = await listAllTools(client);
      this.tools = new Map(tools.map((tool) => [tool.name, tool]));
      this.client = client;
      this.connectionError = null;
      this.retryAfter = 0;
      this.logger.info({ 
        event: "mcp.server.connected", 
        server: this.serverName, 
        tools: tools.length 
      });
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : String(error);
      this.retryAfter = Date.now() + 15_000;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools(): Promise<ExternalToolDefinition[]> {
    if (!this.client && !this.closed && Date.now() >= this.retryAfter) {
      try { await this.connect(); }
      catch (error) {
        this.logger.warn({ 
          event: "mcp.server.connect_failed", 
          server: this.serverName, error: error instanceof Error ? error.message : String(error) 
        });
        return [];
      }
    }
    return [...this.tools.values()].map((tool) => ({
      name: publicToolName(this.serverName, tool.name),
      description: `[MCP: ${this.serverName}] ${tool.description ?? tool.name}`,
      inputJsonSchema: tool.inputSchema as Record<string, unknown>,
      execution: { concurrency: "exclusive" },
    }));
  }

  async getPermissionRequirement(name: string): Promise<ToolPermissionRequirement> {
    const tool = this.findTool(name);
    return { 
      capability: `mcp.${this.serverName}`, 
      resource: `${tool.name}@${this.instanceId}`, 
      action: "execute" 
    };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    const tool = this.findTool(name);
    const authorization = context.authorization?.requirement;
    if (authorization?.capability !== `mcp.${this.serverName}` || authorization.resource !== `${tool.name}@${this.instanceId}` || authorization.action !== "execute") {
      throw new Error(`MCP tool ${name} does not have authorization.`);
    }
    this.activeCalls += 1;
    try {
      await this.connect();
      context.signal?.throwIfAborted();
      const result = await this.client!.callTool(
        { name: tool.name, arguments: input as Record<string, unknown> }, 
        context.signal ? { signal: context.signal } : undefined
      );
      if (result.isError) throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
      return result;
    } finally {
      this.activeCalls -= 1;
      if (this.retired && this.activeCalls === 0) {
        await this.close().catch(() => undefined);
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
    }
  }

  async retire(): Promise<void> {
    this.retired = true;
    if (this.activeCalls === 0) return this.close();
    await new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      if (this.connecting) await this.connecting.catch(() => undefined);
      const client = this.client;
      this.client = null;
      this.tools.clear();
      if (client) await client.close();
    })();
    return this.closePromise;
  }

  private findTool(name: string): Tool {
    const tool = [...this.tools.values()].find((entry) => publicToolName(this.serverName, entry.name) === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return tool;
  }
}

function publicToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_]/g, "_")}__${tool.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}
