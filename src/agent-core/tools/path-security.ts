import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalizePotentialPath(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  let existing = resolved;
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const canonicalExisting = await realpath(existing);
      return path.resolve(canonicalExisting, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function toolBaseDirectory(cwd: string | null): string {
  return path.resolve(cwd ?? process.cwd());
}

export async function resolveToolPath(cwd: string | null, inputPath: string): Promise<string> {
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(toolBaseDirectory(cwd), inputPath);
  return canonicalizePotentialPath(candidate);
}

export function isFilesystemRoot(inputPath: string): boolean {
  const resolved = path.resolve(inputPath);
  return pathsEqual(resolved, path.parse(resolved).root);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
