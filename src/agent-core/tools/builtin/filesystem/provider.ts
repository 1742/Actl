import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
  type ToolProvider,
} from "../../registry.js";
import { ApplyPatchToolHandler } from "./apply-patch.js";
import { PathOperationsToolHandler } from "./path-operations.js";
import { ReadFileToolHandler } from "./read-file.js";
import { SearchToolHandler } from "./search.js";
import type { FilesystemToolHandler } from "./types.js";
import { WriteFileToolHandler } from "./write-file.js";
import { WorkspaceFileService } from "../../../runtime/workspace-files.js";

export class FilesystemToolProvider implements ToolProvider {
  readonly name = "builtin-filesystem";
  private readonly handlers: readonly FilesystemToolHandler[];

  constructor(handlers?: readonly FilesystemToolHandler[], workspaceFiles = new WorkspaceFileService()) {
    this.handlers = handlers ?? defaultHandlers(workspaceFiles);
  }

  async listTools(): Promise<ToolDefinition[]> {
    const definitions = (await Promise.all(this.handlers.map((handler) => handler.listTools()))).flat();
    assertUniqueNames(definitions);
    return definitions;
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    context.signal?.throwIfAborted();
    const handler = await this.resolveHandler(name);
    if (!handler) return unsupportedRequirement(name);
    if (!handler.getPermissionRequirement) {
      return {
        capability: `tool.${name}`,
        action: "execute",
      };
    }
    const requirement = await handler.getPermissionRequirement(name, input, context);
    context.signal?.throwIfAborted();
    return requirement;
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const handler = await this.resolveHandler(name);
    if (!handler) throw new Error(`Unsupported filesystem tool: ${name}`);
    const output = await handler.callTool(name, input, context);
    context.signal?.throwIfAborted();
    return output;
  }

  private async resolveHandler(name: string): Promise<FilesystemToolHandler | null> {
    let match: FilesystemToolHandler | null = null;
    for (const handler of this.handlers) {
      if (!(await handler.listTools()).some((definition) => definition.name === name)) continue;
      if (match) throw new Error(`Filesystem tool is handled more than once: ${name}`);
      match = handler;
    }
    return match;
  }
}

function defaultHandlers(workspaceFiles: WorkspaceFileService): FilesystemToolHandler[] {
  return [
    new ReadFileToolHandler(),
    new WriteFileToolHandler(),
    new ApplyPatchToolHandler(),
    new SearchToolHandler(workspaceFiles),
    new PathOperationsToolHandler(),
  ];
}

function assertUniqueNames(definitions: readonly ToolDefinition[]): void {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) {
      throw new Error(`Filesystem tool is handled more than once: ${definition.name}`);
    }
    names.add(definition.name);
  }
}

function unsupportedRequirement(name: string): ToolPermissionRequirement {
  throw new Error(`Unsupported filesystem tool: ${name}`);
}
