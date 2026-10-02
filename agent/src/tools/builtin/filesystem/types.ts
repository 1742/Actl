import type {
  ToolCallContext,
  ToolDefinition,
  ToolPermissionRequirement,
} from "../../registry.js";

export interface FilesystemToolHandler {
  listTools(): Promise<ToolDefinition[]>;
  getPermissionRequirement?(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement>;
  callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown>;
}
