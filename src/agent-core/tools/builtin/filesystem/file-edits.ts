import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalizePotentialPath, isPathInside, resolveToolPath } from "../../path-security.js";
import type { ToolCallContext } from "../../registry.js";

export const sha256Schema = z.string().regex(/^[a-f\d]{64}$/i);

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function resolveEditPath(context: ToolCallContext, input: string): Promise<string> {
  const resolved = await resolveToolPath(context.cwd, input);
  if (context.fileEditRoots) {
    const roots = await Promise.all(context.fileEditRoots.map(canonicalizePotentialPath));
    if (!roots.some((root) => isPathInside(root, resolved))) {
      throw new Error(`Subagent edit is outside its workspace: ${input}`);
    }
  }
  return resolved;
}

export async function readFileVersion(filePath: string, inputPath: string, expectedSha256: string, signal?: AbortSignal) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Edit target must be a regular file: ${inputPath}`);
    const content = await readFile(filePath, { signal });
    const actual = sha256(content);
    if (actual === expectedSha256.toLowerCase()) return { content, mode: info.mode, sha256: actual };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error(`SHA-256 precondition failed for ${inputPath}. Read the current file with read_file before editing again.`);
}

export async function createFile(filePath: string, inputPath: string, content: string): Promise<void> {
  let file;
  try {
    file = await open(filePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`File already exists: ${inputPath}. Read it and provide expectedSha256 to update it.`);
  }
  try {
    try { await file.writeFile(content); }
    finally { await file.close(); }
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
}

export async function replaceFile(filePath: string, content: Buffer | string, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.actl-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", mode);
  try {
    try { await file.writeFile(content); }
    finally { await file.close(); }
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
