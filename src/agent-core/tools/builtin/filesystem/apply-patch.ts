import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { resolveToolPath, toolBaseDirectory } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";

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
    expectedSha256: z.string().regex(/^[a-f\d]{64}$/i).optional()
      .describe("Optional SHA-256 precondition from read_file."),
    replacements: z.array(replacementSchema).min(1),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  const paths = new Set<string>();
  for (const [index, patch] of value.patches.entries()) {
    const key = process.platform === "win32" ? patch.path.toLowerCase() : patch.path;
    if (paths.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["patches", index, "path"],
        message: "Each path may appear only once per apply_patch call.",
      });
    }
    paths.add(key);
  }
});

type ApplyPatchInput = z.infer<typeof applyPatchInputSchema>;

interface StagedPatch {
  path: string;
  resolvedPath: string;
  originalContent: string;
  newContent: string;
  originalSha256: string;
  newSha256: string;
  replacementsApplied: number;
}

export class ApplyPatchToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "apply_patch",
      description: "Apply a validated batch of exact text replacements to accessible files. Every replacement and optional SHA-256 precondition is checked before writing.",
      inputSchema: applyPatchInputSchema,
    }];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name !== "apply_patch") throw new Error(`Unsupported builtin tool: ${name}`);
    const paths = await Promise.all((input as ApplyPatchInput).patches.map((patch) =>
      resolveToolPath(context.cwd, patch.path)));
    return { capability: "filesystem.patch", resource: JSON.stringify(paths), action: "write" };
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name !== "apply_patch") throw new Error(`Unsupported builtin tool: ${name}`);
    const parsedInput = input as ApplyPatchInput;
    const authorizedPaths = await Promise.all(parsedInput.patches.map((patch) => resolveToolPath(context.cwd, patch.path)));
    const authorization = context.authorization;
    if (
      !authorization ||
      authorization.requirement.capability !== "filesystem.patch" ||
      authorization.requirement.resource !== JSON.stringify(authorizedPaths)
    ) {
      throw new Error("apply_patch does not have authorization for the resolved files.");
    }

    const staged: StagedPatch[] = [];
    const resolvedPaths = new Set<string>();
    for (const patch of parsedInput.patches) {
      context.signal?.throwIfAborted();
      const resolvedPath = await resolveToolPath(context.cwd, patch.path);
      const resolvedKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
      if (resolvedPaths.has(resolvedKey)) {
        throw new Error(`Multiple patch paths resolve to the same file: ${patch.path}`);
      }
      resolvedPaths.add(resolvedKey);
      const originalContent = await readFile(resolvedPath, { encoding: "utf8", signal: context.signal });
      const originalSha256 = sha256(originalContent);
      if (patch.expectedSha256 && patch.expectedSha256.toLowerCase() !== originalSha256) {
        throw new Error(`SHA-256 precondition failed for ${patch.path}.`);
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
        originalSha256,
        newSha256: sha256(newContent),
        replacementsApplied,
      });
    }

    const written: StagedPatch[] = [];
    try {
      for (const patch of staged) {
        context.signal?.throwIfAborted();
        written.push(patch);
        await writeFile(patch.resolvedPath, patch.newContent, { encoding: "utf8", signal: context.signal });
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const patch of written.reverse()) {
        try {
          await writeFile(patch.resolvedPath, patch.originalContent, "utf8");
        } catch (rollbackError) {
          rollbackErrors.push(`${patch.path}: ${errorMessage(rollbackError)}`);
        }
      }
      const suffix = rollbackErrors.length > 0 ? ` Rollback also failed: ${rollbackErrors.join("; ")}` : "";
      throw new Error(`apply_patch failed: ${errorMessage(error)}.${suffix}`);
    }

    return {
      filesChanged: staged.length,
      files: staged.map((patch) => ({
        path: path.isAbsolute(patch.path)
          ? patch.resolvedPath
          : normalizeRelative(toolBaseDirectory(context.cwd), patch.resolvedPath),
        replacementsApplied: patch.replacementsApplied,
        previousSha256: patch.originalSha256,
        sha256: patch.newSha256,
      })),
    };
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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
