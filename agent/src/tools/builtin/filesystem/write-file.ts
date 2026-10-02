import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { pathsEqual, resolveToolPath, toolBaseDirectory } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";

export const writeFileInputSchema = z.object({
  path: z.string().trim().min(1).describe("Absolute path or path relative to the Session cwd."),
  content: z.string().describe("UTF-8 text content to write."),
}).strict();

type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export class WriteFileToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "write_file",
        description: "Write UTF-8 text content to any file path accessible to the host process, creating missing parent directories as needed.",
        inputSchema: writeFileInputSchema,
      },
    ];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name !== "write_file") throw new Error(`Unsupported builtin tool: ${name}`);
    const resource = await resolveToolPath(context.cwd, (input as WriteFileInput).path);
    return { capability: "filesystem.write", resource, action: "write" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "write_file") throw new Error(`Unsupported builtin tool: ${name}`);

    const parsedInput = input as WriteFileInput;
    const resolvedPath = await resolveToolPath(context.cwd, parsedInput.path);
    const authorization = context.authorization;
    if (
      !authorization ||
      authorization.requirement.capability !== "filesystem.write" ||
      !authorization.requirement.resource ||
      !pathsEqual(authorization.requirement.resource, resolvedPath)
    ) {
      throw new Error("write_file does not have authorization for the resolved target path.");
    }

    context.signal?.throwIfAborted();
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    context.signal?.throwIfAborted();
    await writeFile(resolvedPath, parsedInput.content, { encoding: "utf8", signal: context.signal });
    return {
      path: path.isAbsolute(parsedInput.path)
        ? resolvedPath
        : path.relative(toolBaseDirectory(context.cwd), resolvedPath),
      bytesWritten: Buffer.byteLength(parsedInput.content, "utf8"),
    };
  }
}
