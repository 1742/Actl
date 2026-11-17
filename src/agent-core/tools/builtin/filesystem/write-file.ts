import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { pathsEqual, toolBaseDirectory } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";
import { reviewText, tracksFile } from "../../review-snapshot.js";
import { createFile, readFileVersion, replaceFile, resolveEditPath, sha256, sha256Schema } from "./file-edits.js";

export const writeFileInputSchema = z.object({
  path: z.string().trim().min(1).describe("Absolute path or path relative to the Session cwd."),
  content: z.string().describe("UTF-8 text content to write."),
  expectedSha256: sha256Schema.optional().describe("Required when replacing a file. Use the SHA-256 returned by read_file. Omit only to create a new file."),
}).strict();

type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export class WriteFileToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "write_file",
        description: "Create a UTF-8 file or replace an existing file at a known SHA-256. Missing parent directories are created for new files.",
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
    const resource = await resolveEditPath(context, (input as WriteFileInput).path);
    return { capability: "filesystem.write", resource, action: "write" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "write_file") throw new Error(`Unsupported builtin tool: ${name}`);

    const parsedInput = input as WriteFileInput;
    const resolvedPath = await resolveEditPath(context, parsedInput.path);
    const authorization = context.authorization;
    if (
      !authorization ||
      authorization.requirement.capability !== "filesystem.write" ||
      !authorization.requirement.resource ||
      !pathsEqual(authorization.requirement.resource, resolvedPath)
    ) {
      throw new Error("write_file does not have authorization for the resolved target path.");
    }

    const previous = parsedInput.expectedSha256 === undefined ? undefined
      : await readFileVersion(resolvedPath, parsedInput.path, parsedInput.expectedSha256, context.signal);
    context.signal?.throwIfAborted();
    if (previous) {
      await replaceFile(resolvedPath, parsedInput.content, previous.mode);
    } else {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      context.signal?.throwIfAborted();
      await createFile(resolvedPath, parsedInput.path, parsedInput.content);
    }
    if (tracksFile(context, resolvedPath)) await context.recordFileChange?.({
      filePath: resolvedPath,
      created: !previous,
      before: previous && reviewText(previous.content.toString("utf8")),
      after: reviewText(parsedInput.content),
    });
    return {
      path: path.isAbsolute(parsedInput.path)
        ? resolvedPath
        : path.relative(toolBaseDirectory(context.cwd), resolvedPath),
      bytesWritten: Buffer.byteLength(parsedInput.content, "utf8"),
      sha256: sha256(parsedInput.content),
    };
  }
}
