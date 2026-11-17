import { reviewText, tracksFile } from "../../review-snapshot.js";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { toolBaseDirectory, workspacePathKey } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";
import { readFileVersion, replaceFile, resolveEditPath, sha256, sha256Schema } from "./file-edits.js";

const filePathSchema = z.string().trim().min(1)
  .describe("Absolute path or path relative to the Session cwd.");

const replacementSchema = z.object({
  oldText: z.string().min(1).describe("Exact UTF-8 text that must currently exist."),
  newText: z.string().describe("Replacement UTF-8 text."),
  expectedOccurrences: z.number().int().min(1).default(1)
    .describe("Required number of non-overlapping occurrences. Defaults to 1."),
}).strict();

export const applyPatchInputSchema = z.object({
  patches: z.array(z.object({
    path: filePathSchema,
    expectedSha256: sha256Schema.describe("SHA-256 of the current file, returned by read_file."),
    replacements: z.array(replacementSchema).min(1),
  }).strict()).min(1).max(50),
}).strict();

type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

interface StagedPatch {
  path: string;
  resolvedPath: string;
  originalContent: string;
  newContent: string;
  originalSha256: string;
  mode: number;
  replacementsApplied: number;
}

export class ApplyPatchToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "apply_patch",
      description: "Apply exact UTF-8 text replacements to existing files. Read each file first. All SHA-256 preconditions and replacements are checked before writing.",
      inputSchema: applyPatchInputSchema,
    }];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name !== "apply_patch") throw new Error(`Unsupported builtin tool: ${name}`);
    const paths = await this.resolvePaths(input as ApplyPatchInput, context);
    return { capability: "filesystem.patch", resource: JSON.stringify(paths), action: "write" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "apply_patch") throw new Error(`Unsupported builtin tool: ${name}`);
    const parsedInput = input as ApplyPatchInput;
    const resolvedPaths = await this.resolvePaths(parsedInput, context);
    const authorization = context.authorization;
    if (
      !authorization ||
      authorization.requirement.capability !== "filesystem.patch" ||
      authorization.requirement.resource !== JSON.stringify(resolvedPaths)
    ) {
      throw new Error("apply_patch does not have authorization for the resolved files.");
    }

    const staged: StagedPatch[] = [];
    for (const [index, patch] of parsedInput.patches.entries()) {
      context.signal?.throwIfAborted();
      const resolvedPath = resolvedPaths[index]!;
      const version = await readFileVersion(resolvedPath, patch.path, patch.expectedSha256, context.signal);
      const originalContent = version.content.toString("utf8");
      if (!Buffer.from(originalContent, "utf8").equals(version.content)) {
        throw new Error(`Patch target is not valid UTF-8: ${patch.path}`);
      }

      let newContent = originalContent;
      let replacementsApplied = 0;
      for (const replacement of patch.replacements) {
        context.signal?.throwIfAborted();
        const occurrences = countOccurrences(newContent, replacement.oldText);
        if (occurrences !== replacement.expectedOccurrences) {
          throw new Error(
            `Expected ${replacement.expectedOccurrences} occurrence(s) in ${patch.path}, found ${occurrences}.`,
          );
        }
        newContent = newContent.split(replacement.oldText).join(replacement.newText);
        replacementsApplied += occurrences;
      }
      staged.push({
        path: patch.path,
        resolvedPath,
        originalContent,
        newContent,
        originalSha256: version.sha256,
        mode: version.mode,
        replacementsApplied,
      });
    }

    const written: StagedPatch[] = [];
    try {
      for (const patch of staged) {
        context.signal?.throwIfAborted();
        if (patch.originalContent === patch.newContent) continue;
        await replaceFile(patch.resolvedPath, patch.newContent, patch.mode);
        written.push(patch);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const patch of written.reverse()) {
        try {
          // A user or shell command may have edited a file outside the runtime's write queue.
          await readFileVersion(patch.resolvedPath, patch.path, sha256(patch.newContent));
          await replaceFile(patch.resolvedPath, patch.originalContent, patch.mode);
        } catch (rollbackError) {
          rollbackErrors.push(`${patch.path}: ${errorMessage(rollbackError)}`);
        }
      }
      const suffix = rollbackErrors.length > 0 ? ` Rollback also failed: ${rollbackErrors.join("; ")}` : "";
      throw new Error(`apply_patch failed: ${errorMessage(error)}.${suffix}`);
    }

    for (const patch of staged) {
      if (patch.originalContent === patch.newContent || !tracksFile(context, patch.resolvedPath)) continue;
      await context.recordFileChange?.({
        filePath: patch.resolvedPath,
        created: false,
        before: reviewText(patch.originalContent),
        after: reviewText(patch.newContent),
      });
    }
    return {
      filesChanged: written.length,
      files: staged.map((patch) => ({
        path: path.isAbsolute(patch.path)
          ? patch.resolvedPath
          : normalizeRelative(toolBaseDirectory(context.cwd), patch.resolvedPath),
        replacementsApplied: patch.replacementsApplied,
        previousSha256: patch.originalSha256,
        sha256: sha256(patch.newContent),
      })),
    };
  }

  private async resolvePaths(input: ApplyPatchInput, context: ToolCallContext): Promise<string[]> {
    const paths = await Promise.all(input.patches.map((patch) => resolveEditPath(context, patch.path)));
    if (new Set(paths.map(workspacePathKey)).size !== paths.length) {
      throw new Error("Each resolved file may appear only once per patch.");
    }
    return paths;
  }
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}

function normalizeRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
