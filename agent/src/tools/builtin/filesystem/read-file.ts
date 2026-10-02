import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { pathsEqual, resolveToolPath, toolBaseDirectory } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";

export const readFileInputSchema = z.object({
  path: z.string().trim().min(1).describe("Absolute path or path relative to the Session cwd."),
  startLine: z.number().int().min(1).default(1).describe("First 1-based line to return."),
  maxLines: z.number().int().min(1).max(10_000).default(2_000)
    .describe("Maximum number of lines to return."),
  maxBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024)
    .describe("Maximum UTF-8 bytes to return."),
}).strict();

type ReadFileInput = z.infer<typeof readFileInputSchema>;

export class ReadFileToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "read_file",
      description: "Read a bounded range of any UTF-8 text file accessible to the host process, with line and SHA-256 metadata.",
      inputSchema: readFileInputSchema,
      execution: { concurrency: "parallel" },
    }];
  }

  async getPermissionRequirement(_name: string, input: unknown, context: ToolCallContext): Promise<ToolPermissionRequirement> {
    const resolvedPath = await resolveToolPath(context.cwd, (input as ReadFileInput).path);
    return { capability: "filesystem.read", resource: resolvedPath, action: "read" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "read_file") throw new Error(`Unsupported builtin tool: ${name}`);
    const parsedInput = input as ReadFileInput;
    const resolvedPath = await resolveToolPath(context.cwd, parsedInput.path);
    const requirement = context.authorization?.requirement;
    if (!requirement || requirement.capability !== "filesystem.read" ||
      !requirement.resource || !pathsEqual(requirement.resource, resolvedPath)) {
      throw new Error("read_file does not have authorization for the resolved path.");
    }
    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) throw new Error("read_file path must be a regular file.");

    const content = await readFile(resolvedPath, { encoding: "utf8", signal: context.signal });
    const lines = content.split(/\r?\n/);
    const startIndex = parsedInput.startLine - 1;
    const selected: string[] = [];
    let bytes = 0;
    let byteLimited = false;
    for (const line of lines.slice(startIndex, startIndex + parsedInput.maxLines)) {
      context.signal?.throwIfAborted();
      const lineBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
      if (bytes + lineBytes > parsedInput.maxBytes) {
        byteLimited = true;
        break;
      }
      selected.push(line);
      bytes += lineBytes;
    }
    const endLine = selected.length === 0 ? null : parsedInput.startLine + selected.length - 1;
    const truncated = byteLimited || startIndex + selected.length < lines.length;

    return {
      path: path.isAbsolute(parsedInput.path)
        ? resolvedPath
        : path.relative(toolBaseDirectory(context.cwd), resolvedPath).split(path.sep).join("/"),
      startLine: parsedInput.startLine,
      endLine,
      totalLines: lines.length,
      sizeBytes: fileStat.size,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      truncated,
      content: selected.join("\n"),
    };
  }
}
