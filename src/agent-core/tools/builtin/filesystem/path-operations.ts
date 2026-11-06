import { lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ToolCallContext,
  type ToolDefinition,
  type ToolPermissionRequirement,
} from "../../registry.js";
import { canonicalizePotentialPath, isFilesystemRoot, resolveToolPath, toolBaseDirectory } from "../../path-security.js";
import type { FilesystemToolHandler } from "./types.js";

const filePathSchema = z.string().trim().min(1);

export const listDirectoryInputSchema = z.object({
  path: filePathSchema.default(".").describe("Absolute path or path relative to the Session cwd."),
  depth: z.number().int().min(1).max(5).default(1).describe("Maximum directory depth to list."),
  maxEntries: z.number().int().min(1).max(2_000).default(500),
  includeHidden: z.boolean().default(true),
}).strict();

export const movePathInputSchema = z.object({
  source: filePathSchema.describe("Existing absolute path or path relative to the Session cwd."),
  destination: filePathSchema.describe("Destination absolute path or path relative to the Session cwd."),
}).strict();

export const deletePathInputSchema = z.object({
  path: filePathSchema.describe("Absolute path or path relative to the Session cwd."),
  recursive: z.boolean().default(false)
    .describe("Required for non-empty directories."),
}).strict();

type ListDirectoryInput = z.infer<typeof listDirectoryInputSchema>;
type MovePathInput = z.infer<typeof movePathInputSchema>;
type DeletePathInput = z.infer<typeof deletePathInputSchema>;

interface DirectoryEntryOutput {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes: number;
  modifiedAt: string;
}

export class PathOperationsToolHandler implements FilesystemToolHandler {

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "list_directory",
        description: "List any accessible directory with bounded recursion and metadata.",
        inputSchema: listDirectoryInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "move_path",
        description: "Move or rename an accessible file or directory. The destination must not already exist.",
        inputSchema: movePathInputSchema,
      },
      {
        name: "delete_path",
        description: "Delete an accessible file or directory. Filesystem roots are always protected.",
        inputSchema: deletePathInputSchema,
      },
    ];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name === "list_directory") {
      const resource = await resolveToolPath(context.cwd, (input as ListDirectoryInput).path);
      return { capability: "filesystem.read", resource, action: "list" };
    }
    if (name === "move_path") {
      const parsed = input as MovePathInput;
      const source = await resolveEntryPath(context.cwd, parsed.source);
      const destination = await resolveEntryPath(context.cwd, parsed.destination);
      if (isFilesystemRoot(source) || isFilesystemRoot(destination)) throw new Error("move_path cannot move a filesystem root.");
      return { capability: "filesystem.move", resource: moveResource(source, destination), action: "move" };
    }
    if (name === "delete_path") {
      const target = await resolveEntryPath(context.cwd, (input as DeletePathInput).path);
      if (isFilesystemRoot(target)) throw new Error("delete_path cannot delete a filesystem root.");
      return { capability: "filesystem.delete", resource: target, action: "delete" };
    }
    throw new Error(`Unsupported builtin tool: ${name}`);
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name === "list_directory") return this.listDirectory(input as ListDirectoryInput, context);
    if (name === "move_path") return this.movePath(input as MovePathInput, context);
    if (name === "delete_path") return this.deletePath(input as DeletePathInput, context);
    throw new Error(`Unsupported builtin tool: ${name}`);
  }

  private async listDirectory(input: ListDirectoryInput, context: ToolCallContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const root = await resolveToolPath(context.cwd, input.path);
    assertAuthorization(context, "filesystem.read", root);
    if (!(await lstat(root)).isDirectory()) throw new Error("list_directory path must be a directory.");
    const entries: DirectoryEntryOutput[] = [];
    let truncated = false;

    const visit = async (directory: string, depth: number): Promise<void> => {
      context.signal?.throwIfAborted();
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        context.signal?.throwIfAborted();
        if (!input.includeHidden && child.name.startsWith(".")) continue;
        if (entries.length >= input.maxEntries) {
          truncated = true;
          return;
        }
        const childPath = path.join(directory, child.name);
        const childStat = await lstat(childPath);
        const type = child.isFile() ? "file"
          : child.isDirectory() ? "directory"
          : child.isSymbolicLink() ? "symlink"
          : "other";
        entries.push({
          path: normalizeRelative(root, childPath),
          type,
          sizeBytes: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
        });
        if (child.isDirectory() && depth < input.depth) {
          await visit(childPath, depth + 1);
          if (truncated) return;
        }
      }
    };
    await visit(root, 1);
    return { path: root, entries, truncated };
  }

  private async movePath(input: MovePathInput, context: ToolCallContext): Promise<unknown> {
    const source = await resolveEntryPath(context.cwd, input.source);
    const destination = await resolveEntryPath(context.cwd, input.destination);
    if (isFilesystemRoot(source) || isFilesystemRoot(destination)) throw new Error("move_path cannot move a filesystem root.");
    assertAuthorization(context, "filesystem.move", moveResource(source, destination));
    context.signal?.throwIfAborted();
    await lstat(source);
    try {
      await lstat(destination);
      throw new Error("move_path destination already exists.");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    context.signal?.throwIfAborted();
    await rename(source, destination);
    return {
      source,
      destination,
    };
  }

  private async deletePath(input: DeletePathInput, context: ToolCallContext): Promise<unknown> {
    const target = await resolveEntryPath(context.cwd, input.path);
    if (isFilesystemRoot(target)) throw new Error("delete_path cannot delete a filesystem root.");
    assertAuthorization(context, "filesystem.delete", target);
    context.signal?.throwIfAborted();
    const targetStat = await lstat(target);
    if (targetStat.isDirectory() && !targetStat.isSymbolicLink() && !input.recursive) {
      context.signal?.throwIfAborted();
      await rmdir(target);
    } else {
      context.signal?.throwIfAborted();
      await rm(target, { recursive: input.recursive, force: false });
    }
    return { path: target, type: targetStat.isDirectory() ? "directory" : "file" };
  }
}

function normalizeRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function moveResource(source: string, destination: string): string {
  return JSON.stringify({ source, destination });
}

async function resolveEntryPath(cwd: string | null, inputPath: string): Promise<string> {
  const lexicalPath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(toolBaseDirectory(cwd), inputPath);
  const canonicalParent = await canonicalizePotentialPath(path.dirname(lexicalPath));
  return path.join(canonicalParent, path.basename(lexicalPath));
}

function assertAuthorization(context: ToolCallContext, capability: string, resource: string): void {
  const requirement = context.authorization?.requirement;
  if (!requirement || requirement.capability !== capability || requirement.resource !== resource) {
    throw new Error(`Missing ${capability} authorization for the resolved path.`);
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
