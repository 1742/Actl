import type { Logger } from "../observability/logger.js";
import { z } from "zod";
import type { ToolCallContext, ToolDefinition, ToolPermissionRequirement, ToolProvider } from "../tools/registry.js";
import type { SecretProtector } from "../security/secret-protector.js";
import { serverSchema, type McpConfig, type McpConfigRepository, type McpServerConfig } from "./mcp-config.js";
import { McpToolProvider } from "./mcp-tool-provider.js";

export interface McpServerView {
  name: string;
  config: McpServerConfig;
  connected: boolean;
  error: string | null;
  tools: Array<{ name: string; description: string }>;
}

const searchInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe("Optional words to match against MCP server names, tool names, and descriptions."),
  server: z.string().trim().min(1).optional().describe("Limit results to this MCP server, including one selected by the user."),
  limit: z.number().int().min(1).max(20).optional().describe("Maximum tools to return. Defaults to 10."),
  offset: z.number().int().min(0).optional().describe("Skip this many matching tools to fetch another page. Defaults to 0."),
}).strict();

const callInputSchema = z.object({
  toolName: z.string().startsWith("mcp__").describe("Exact tool name returned by search_mcp_tools."),
  arguments: z.record(z.string(), z.unknown()).describe("Arguments matching the tool's inputSchema from search_mcp_tools."),
}).strict();

export class McpServerManager implements ToolProvider {
  readonly name = "mcp";
  private config: McpConfig = { servers: {} };
  private providers = new Map<string, McpToolProvider>();
  private mutation: Promise<void> = Promise.resolve();
  private readonly retired = new Set<Promise<void>>();

  constructor(
    private readonly homeDirectory: string,
    private readonly repository: McpConfigRepository,
    private readonly secrets: SecretProtector,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    this.config = { servers: Object.fromEntries(this.repository.listMcpServers().map(({ name, credential }) => [
      name, serverSchema.parse(JSON.parse(this.secrets.decrypt(credential))),
    ])) };
    for (const [name, config] of Object.entries(this.config.servers)) {
      this.assertUniquePublicPrefix(name);
      if (!config.enabled) continue;
      const provider = this.createProvider(name, config);
      this.providers.set(name, provider);
    }
    await Promise.all([...this.providers.values()].map(async (provider) => {
      try { await provider.connect(); }
      catch (error) {
        this.logger.warn({ event: "mcp.server.start_failed", server: provider.serverName, error: error instanceof Error ? error.message : String(error) });
      }
    }));
  }

  listServers(): McpServerView[] {
    return Object.entries(this.config.servers).map(([name, config]) => {
      const provider = this.providers.get(name);
      return {
        name,
        config,
        connected: provider?.status.connected ?? false,
        error: provider?.status.error ?? null,
        tools: provider?.toolDetails ?? [],
      };
    });
  }

  async saveServer(name: string, config: McpServerConfig): Promise<McpServerView> {
    return this.mutate(async () => {
      this.assertUniquePublicPrefix(name);
      const nextProvider = config.enabled ? this.createProvider(name, config) : null;
      if (nextProvider) {
        try { await nextProvider.connect(); }
        catch (error) {
          this.logger.warn({ event: "mcp.server.connect_failed", server: name, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const next = { servers: { ...this.config.servers, [name]: config } };
      try { await this.repository.upsertMcpServer({ name, credential: this.secrets.encrypt(JSON.stringify(config)) }); }
      catch (error) {
        await nextProvider?.close();
        throw error;
      }
      const previous = this.providers.get(name);
      this.config = next;
      if (nextProvider) this.providers.set(name, nextProvider);
      else this.providers.delete(name);
      if (previous) this.trackRetirement(previous.retire());
      return this.listServers().find((server) => server.name === name)!;
    });
  }

  async deleteServer(name: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.config.servers[name]) throw new Error(`MCP server does not exist: ${name}`);
      const servers = { ...this.config.servers };
      delete servers[name];
      await this.repository.deleteMcpServer(name);
      this.config = { servers };
      const previous = this.providers.get(name);
      this.providers.delete(name);
      if (previous) this.trackRetirement(previous.retire());
    });
  }

  async testServer(name: string, config: McpServerConfig): Promise<{ tools: Array<{ name: string; description: string }> }> {
    const provider = this.createProvider(name, config);
    try {
      await provider.connect();
      return { tools: provider.toolDetails };
    } finally {
      await provider.close();
    }
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "search_mcp_tools",
        description: "Search currently available MCP tools by server, name, or purpose. Returns exact tool names and input schemas. Use this before call_mcp_tool, especially for a user-selected MCP server reference.",
        inputSchema: searchInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "call_mcp_tool",
        description: "Call an MCP tool found with search_mcp_tools. Supply its exact toolName and arguments matching the returned inputSchema. The underlying tool's permission is checked before execution.",
        inputSchema: callInputSchema,
        execution: { concurrency: "exclusive" },
      },
    ];
  }

  async listCatalog(): Promise<Array<{ name: string; connected: boolean; toolCount: number }>> {
    return Promise.all([...this.providers.entries()].map(async ([name, provider]) => {
      const tools = await provider.listTools();
      return { name, connected: provider.status.connected, toolCount: tools.length };
    }));
  }

  async getPermissionRequirement(name: string, input: unknown, context: ToolCallContext): Promise<ToolPermissionRequirement> {
    void context;
    if (name === "search_mcp_tools") return { capability: "mcp.read", resource: "tool-catalog", action: "list" };
    if (name === "call_mcp_tool") {
      const { toolName } = callInputSchema.parse(input);
      return (await this.findProvider(toolName)).getPermissionRequirement(toolName);
    }
    throw new Error(`Unknown MCP tool: ${name}`);
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name === "search_mcp_tools") {
      const authorization = context.authorization?.requirement;
      if (authorization?.capability !== "mcp.read" || authorization.resource !== "tool-catalog" || authorization.action !== "list") {
        throw new Error("MCP tool discovery is not authorized.");
      }
      const { query, server, limit = 10, offset = 0 } = searchInputSchema.parse(input);
      const groups = await Promise.all([...this.providers.entries()]
        .filter(([name]) => !server || name === server)
        .map(async ([name, provider]) => ({ server: name, tools: await provider.listTools() })));
      const needle = query?.toLocaleLowerCase();
      const matches = groups.flatMap(({ server, tools }) => tools.map((tool) => ({ server, tool })))
        .filter(({ server, tool }) => !needle || `${server} ${tool.name} ${tool.description}`.toLocaleLowerCase().includes(needle));
      return {
        tools: matches.slice(offset, offset + limit).map(({ server, tool }) => ({
          server,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputJsonSchema,
        })),
        total: matches.length,
        ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
      };
    }
    if (name === "call_mcp_tool") {
      const { toolName, arguments: args } = callInputSchema.parse(input);
      return (await this.findProvider(toolName)).callTool(toolName, args, context);
    }
    throw new Error(`Unknown MCP tool: ${name}`);
  }

  async close(): Promise<void> {
    await this.mutation;
    await Promise.all([...this.providers.values()].map((provider) => provider.close()));
    await Promise.all(this.retired);
    this.providers.clear();
  }

  private trackRetirement(task: Promise<void>): void {
    const tracked = task.catch((error) => {
      this.logger.warn({ event: "mcp.server.close_failed", error: error instanceof Error ? error.message : String(error) });
    });
    this.retired.add(tracked);
    void tracked.finally(() => this.retired.delete(tracked));
  }

  private createProvider(name: string, config: McpServerConfig): McpToolProvider {
    return new McpToolProvider(name, config, this.homeDirectory, this.logger);
  }

  private async findProvider(toolName: string): Promise<McpToolProvider> {
    const candidates = [...this.providers.entries()]
      .filter(([name]) => toolName.startsWith(`mcp__${publicName(name)}__`));
    const matches = (await Promise.all(candidates.map(async ([, provider]) =>
      (await provider.listTools()).some((tool) => tool.name === toolName) ? provider : null,
    ))).filter((provider): provider is McpToolProvider => provider !== null);
    if (matches.length > 1) throw new Error(`MCP tool name is ambiguous: ${toolName}`);
    const match = matches[0];
    if (!match) throw new Error(`Unknown MCP tool: ${toolName}`);
    return match;
  }

  private assertUniquePublicPrefix(name: string): void {
    for (const existing of Object.keys(this.config.servers)) {
      if (existing !== name && publicName(existing) === publicName(name)) {
        throw new Error(`MCP server name collides with ${existing}: ${name}`);
      }
    }
  }

  private async mutate<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(task);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function publicName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
