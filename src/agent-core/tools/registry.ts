import { z } from "zod";
import { RichToolOutput, type ToolCall, type ToolResult } from "../runtime/transcript.js";
import type { ModelCapabilities } from "../model/catalog-types.js";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresImageInput?: boolean;
}

export interface ToolDefinition<TInputSchema extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  execution?: ToolExecutionPolicy;
  requiresImageInput?: boolean;
}

/** External tools already provide JSON Schema; their client validates calls. */
export interface ExternalToolDefinition {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
  execution?: ToolExecutionPolicy;
  requiresImageInput?: boolean;
}

type AnyToolDefinition = ToolDefinition | ExternalToolDefinition;

export interface ToolExecutionPolicy {
  concurrency: "parallel" | "exclusive";
}

export interface ToolPermissionRequirement {
  capability: string;
  resource?: string;
  action?: string;
}

export interface ToolExecutionAuthorization {
  requirement: ToolPermissionRequirement;
  approvedByUser: boolean;
}

export interface ToolCallContext {
  cwd: string | null;
  sessionId?: string;
  authorization?: ToolExecutionAuthorization;
  signal?: AbortSignal;
  modelCapabilities?: ModelCapabilities;
}

export interface ToolProvider {
  name: string;
  listTools(): Promise<AnyToolDefinition[]>;
  getPermissionRequirement?(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement>;
  callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown>;
}

interface ResolvedTool {
  provider: ToolProvider;
  definition: AnyToolDefinition;
}

export type PreparedToolCall =
  | { ok: true; toolCall: ToolCall }
  | { ok: false; result: ToolResult };

export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>();

  registerProvider(provider: ToolProvider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Tool provider is already registered: ${provider.name}`);
    }
    this.providers.set(provider.name, provider);
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  async hasTool(name: string): Promise<boolean> {
    return (await this.listTools()).some((tool) => tool.name === name);
  }

  async listTools(capabilities?: ModelCapabilities): Promise<ToolSchema[]> {
    const toolGroups = await Promise.all(
      [...this.providers.values()].map((provider) => provider.listTools()),
    );
    const definitions = toolGroups.flat();
    assertUniqueToolNames(definitions);
    return definitions.filter((definition) => !capabilities ||
      (capabilities.toolCalling && (!definition.requiresImageInput || capabilities.input.imageMimeTypes.length > 0)))
      .map(toToolSchema);
  }

  async prepareToolCall(toolCall: ToolCall): Promise<PreparedToolCall> {
    const resolved = await this.resolveTool(toolCall.name);
    if (!resolved) {
      return {
        ok: false,
        result: {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: false,
          error: `Unknown tool: ${toolCall.name}`,
        },
      };
    }

    if ("inputJsonSchema" in resolved.definition) {
      if (!toolCall.input || typeof toolCall.input !== "object" || Array.isArray(toolCall.input)) {
        return { ok: false, result: { toolCallId: toolCall.id, toolName: toolCall.name, ok: false, error: `${toolCall.name} input must be an object.` } };
      }
      return { ok: true, toolCall };
    }
    const parsed = resolved.definition.inputSchema.safeParse(toolCall.input);
    if (!parsed.success) {
      return {
        ok: false,
        result: {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ok: false,
          error: formatToolInputError(toolCall.name, parsed.error),
        },
      };
    }

    return {
      ok: true,
      toolCall: { ...toolCall, input: parsed.data },
    };
  }

  async getPermissionRequirement(
    toolCall: ToolCall,
    context: ToolCallContext = { cwd: null },
  ): Promise<ToolPermissionRequirement | null> {
    context.signal?.throwIfAborted();
    const resolved = await this.resolveTool(toolCall.name);
    if (!resolved) return null;
    const parsedInput = parseToolInput(resolved.definition, toolCall.input);
    if (resolved.provider.getPermissionRequirement) {
      const requirement = await resolved.provider.getPermissionRequirement(toolCall.name, parsedInput, context);
      context.signal?.throwIfAborted();
      return requirement;
    }
    return {
      capability: `tool.${toolCall.name}`,
      action: "execute",
    };
  }

  async getExecutionPolicy(toolCall: ToolCall): Promise<ToolExecutionPolicy> {
    const resolved = await this.resolveTool(toolCall.name);
    return resolved?.definition.execution ?? { concurrency: "exclusive" };
  }

  async callTool(toolCall: ToolCall, context: ToolCallContext = { cwd: null }): Promise<ToolResult> {
    try {
      context.signal?.throwIfAborted();
      const prepared = await this.prepareToolCall(toolCall);
      if (!prepared.ok) return prepared.result;
      const resolved = await this.resolveTool(prepared.toolCall.name);
      if (!resolved) return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ok: false,
        error: `Unknown tool: ${toolCall.name}`,
      };
      if (resolved.definition.requiresImageInput && !context.modelCapabilities?.input.imageMimeTypes.length) {
        throw new Error(`${toolCall.name} requires a model with image input support. Switch to a vision model.`);
      }
      const output = await resolved.provider.callTool(
        prepared.toolCall.name,
        prepared.toolCall.input,
        context,
      );
      context.signal?.throwIfAborted();
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ok: true,
        output: output instanceof RichToolOutput ? output.output : output,
        ...(output instanceof RichToolOutput ? { content: structuredClone(output.content) } : {}),
      };
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason;
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveTool(name: string): Promise<ResolvedTool | null> {
    let match: ResolvedTool | null = null;
    for (const provider of this.providers.values()) {
      const definition = (await provider.listTools()).find((tool) => tool.name === name);
      if (!definition) continue;
      if (match) throw new Error(`Tool name is registered by multiple providers: ${name}`);
      match = { provider, definition };
    }
    return match;
  }
}

function assertUniqueToolNames(definitions: AnyToolDefinition[]): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new Error(`Tool name is registered by multiple providers: ${definition.name}`);
    }
    names.add(definition.name);
  }
}

function toToolSchema(definition: AnyToolDefinition): ToolSchema {
  if ("inputJsonSchema" in definition) {
    return { name: definition.name, description: definition.description, inputSchema: definition.inputJsonSchema,
      ...(definition.requiresImageInput ? { requiresImageInput: true } : {}) };
  }
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(definition.inputSchema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "throw",
    reused: "inline",
    cycles: "throw",
  });
  return {
    name: definition.name,
    description: definition.description,
    inputSchema,
    ...(definition.requiresImageInput ? { requiresImageInput: true } : {}),
  };
}

function parseToolInput(definition: AnyToolDefinition, input: unknown): unknown {
  if ("inputJsonSchema" in definition) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${definition.name} input must be an object.`);
    return input;
  }
  const result = definition.inputSchema.safeParse(input);
  if (result.success) return result.data;
  throw new Error(formatToolInputError(definition.name, result.error));
}

function formatToolInputError(toolName: string, error: z.ZodError): string {
  const missing = error.issues.filter((i) => i.message === "Required");
  const details = error.issues.map((issue) => {
    const field = issue.path.join(".");
    const hint = issue.message === "Required"
      ? ` (missing field; add "${field}": <value> to your call)`
      : issue.code === "too_small" && (issue as { minimum?: number }).minimum === 1
        ? ` (must be non-empty)`
        : "";
    return field ? `${field}: ${issue.message}${hint}` : `${issue.message}${hint}`;
  }).join("; ");
  const guidance = missing.length > 0
    ? ` Fix: include ${missing.map((i) => `"${i.path.join(".")}"`).join(", ")} in your next call.`
    : "";
  return `${toolName} input is invalid: ${details}.${guidance}`;
}
