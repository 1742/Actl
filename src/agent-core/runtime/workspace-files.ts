import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalizePotentialPath, isPathInside, pathsEqual } from "../tools/path-security.js";

export type WorkspaceDirectoryErrorCode =
  | "workspace_directory_not_found"
  | "workspace_path_not_directory"
  | "workspace_path_invalid";

export class WorkspaceDirectoryError extends Error {
  constructor(readonly code: WorkspaceDirectoryErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceDirectoryError";
  }
}

interface IgnoreRule {
  negated: boolean;
  regex: RegExp;
}

export interface WalkFilesOptions {
  path?: string;
  includeHidden?: boolean;
  extensions?: ReadonlySet<string> | null;
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface WalkFilesResult {
  scannedFiles: number;
  truncated: boolean;
}

export interface WorkspaceFileSearchItem {
  type: "workspace_file";
  path: string;
  name: string;
}

export interface WorkspaceFileQueryResult {
  data: WorkspaceFileSearchItem[];
  truncated: boolean;
}

export interface WorkspaceDirectoryEntry {
  type: "file" | "directory";
  name: string;
  path: string;
}

export interface WorkspaceDirectoryTree {
  path: string;
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);
const DEFAULT_MAX_SCANNED_FILES = 50_000;

export class WorkspaceFileService {
  async listDirectory(
    workspaceRootInput: string,
    options: { path?: string; maxEntries: number },
  ): Promise<WorkspaceDirectoryTree> {
    const workspaceRoot = await canonicalizePotentialPath(workspaceRootInput);
    let target: string;
    try {
      target = await this.resolveSafePath(workspaceRoot, options.path ?? ".");
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceDirectoryError("workspace_directory_not_found", "Workspace directory not found.");
      }
      throw new WorkspaceDirectoryError("workspace_path_invalid", "Workspace directory path is invalid.");
    }

    let targetStat;
    try {
      targetStat = await lstat(target);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceDirectoryError("workspace_directory_not_found", "Workspace directory not found.");
      }
      throw error;
    }
    if (!targetStat.isDirectory()) {
      throw new WorkspaceDirectoryError("workspace_path_not_directory", "Workspace path must identify a directory.");
    }

    const ignoreRules = await loadIgnoreRules(workspaceRoot);
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => !entry.isSymbolicLink())
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .filter((entry) => !(entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)))
      .map((entry) => ({
        entry,
        path: normalizeRelative(workspaceRoot, path.join(target, entry.name)),
      }))
      .filter(({ entry, path: relativePath }) => !isIgnored(relativePath, entry.isDirectory(), ignoreRules))
      .sort((left, right) => {
        const directoryOrder = Number(right.entry.isDirectory()) - Number(left.entry.isDirectory());
        return directoryOrder || left.entry.name.localeCompare(right.entry.name);
      });

    return {
      path: normalizeDirectoryRelative(workspaceRoot, target),
      entries: entries.slice(0, options.maxEntries).map(({ entry, path: relativePath }) => ({
        type: entry.isDirectory() ? "directory" : "file",
        name: entry.name,
        path: relativePath,
      })),
      truncated: entries.length > options.maxEntries,
    };
  }

  async walkFiles(
    workspaceRootInput: string,
    options: WalkFilesOptions,
    visit: (absolutePath: string, relativePath: string) => boolean | void | Promise<boolean | void>,
  ): Promise<WalkFilesResult> {
    const workspaceRoot = await canonicalizePotentialPath(workspaceRootInput);
    const target = await this.resolveSafePath(workspaceRoot, options.path ?? ".");
    const ignoreRules = await loadIgnoreRules(workspaceRoot);
    const state = { scannedFiles: 0, stopped: false, hitLimit: false };
    const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;

    const walk = async (candidate: string): Promise<void> => {
      options.signal?.throwIfAborted();
      if (state.stopped) return;
      const entryStat = await lstat(candidate);
      if (entryStat.isSymbolicLink()) return;
      if (entryStat.isFile()) {
        if (options.extensions && !options.extensions.has(path.extname(candidate).toLowerCase())) return;
        if (state.scannedFiles >= maxFiles) {
          state.stopped = true;
          state.hitLimit = true;
          return;
        }
        state.scannedFiles += 1;
        state.stopped = (await visit(candidate, normalizeRelative(workspaceRoot, candidate))) === true;
        return;
      }
      if (!entryStat.isDirectory()) return;

      const entries = await readdir(candidate, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        if (state.stopped) return;
        if (!options.includeHidden && entry.name.startsWith(".")) continue;
        if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        const fullPath = path.join(candidate, entry.name);
        const relativePath = normalizeRelative(workspaceRoot, fullPath);
        if (isIgnored(relativePath, entry.isDirectory(), ignoreRules)) continue;
        if (entry.isSymbolicLink()) continue;
        await walk(fullPath);
      }
    };

    await walk(target);
    return { scannedFiles: state.scannedFiles, truncated: state.hitLimit };
  }

  async searchGlob(
    workspaceRoot: string,
    options: { pattern: string; path?: string; includeHidden?: boolean; maxResults: number; signal?: AbortSignal },
  ): Promise<{ files: string[]; scannedFiles: number; truncated: boolean }> {
    const matcher = globPatternToRegex(options.pattern);
    const files: string[] = [];
    const result = await this.walkFiles(workspaceRoot, options, async (_absolutePath, relativePath) => {
      const searchRoot = options.path ? normalizeSearchPrefix(options.path) : "";
      const relativeToSearch = relativePath === searchRoot
        ? path.posix.basename(relativePath)
        : searchRoot && relativePath.startsWith(`${searchRoot}/`)
          ? relativePath.slice(searchRoot.length + 1)
          : relativePath;
      if (matcher.test(relativeToSearch)) files.push(relativePath);
      return files.length >= options.maxResults;
    });
    return { files, scannedFiles: result.scannedFiles, truncated: files.length >= options.maxResults };
  }

  async searchQuery(
    workspaceRoot: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileQueryResult> {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches: Array<{ item: WorkspaceFileSearchItem; score: number }> = [];
    const result = await this.walkFiles(
      workspaceRoot,
      { maxFiles: DEFAULT_MAX_SCANNED_FILES, ...(signal ? { signal } : {}) },
      async (_absolutePath, relativePath) => {
        const score = fuzzyScore(relativePath, normalizedQuery);
        if (score === null) return;
        matches.push({
          item: { type: "workspace_file", path: relativePath, name: path.posix.basename(relativePath) },
          score,
        });
      },
    );
    matches.sort((left, right) => left.score - right.score || left.item.path.localeCompare(right.item.path));
    return {
      data: matches.slice(0, limit).map(({ item }) => item),
      truncated: result.truncated || matches.length > limit,
    };
  }

  async validateReference(workspaceRootInput: string, inputPath: string): Promise<string> {
    if (path.isAbsolute(inputPath)) throw new Error("Workspace file path must be relative.");
    const workspaceRoot = await canonicalizePotentialPath(workspaceRootInput);
    const lexicalTarget = path.resolve(workspaceRoot, inputPath);
    if (!isPathInside(workspaceRoot, lexicalTarget)) throw new Error("Workspace file path is outside the workspace.");
    const canonicalTarget = await realpath(lexicalTarget);
    if (!isPathInside(workspaceRoot, canonicalTarget) || !pathsEqual(lexicalTarget, canonicalTarget)) {
      throw new Error("Workspace file path must not traverse symbolic links.");
    }
    const targetStat = await lstat(canonicalTarget);
    if (!targetStat.isFile()) throw new Error("Workspace file path must identify a regular file.");
    return normalizeRelative(workspaceRoot, canonicalTarget);
  }

  private async resolveSafePath(workspaceRoot: string, inputPath: string): Promise<string> {
    const resolved = await canonicalizePotentialPath(path.resolve(workspaceRoot, inputPath));
    if (!isPathInside(workspaceRoot, resolved)) throw new Error(`Path ${inputPath} is outside the workspace.`);
    return resolved;
  }
}

export function globPatternToRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let output = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${output}$`);
}

function normalizeRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  return relative || path.basename(candidate);
}

function normalizeSearchPrefix(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/|\/$/g, "");
}

async function loadIgnoreRules(workspaceRoot: string): Promise<IgnoreRule[]> {
  try {
    const content = await readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
    return content.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const negated = trimmed.startsWith("!");
      let pattern = negated ? trimmed.slice(1) : trimmed;
      const directoryOnly = pattern.endsWith("/");
      pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
      if (!pattern.includes("/")) pattern = `**/${pattern}`;
      if (directoryOnly) pattern += "/**";
      return [{ negated, regex: globPatternToRegex(pattern) }];
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isIgnored(relativePath: string, directory: boolean, rules: IgnoreRule[]): boolean {
  const candidate = directory ? `${relativePath}/placeholder` : relativePath;
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(candidate) || rule.regex.test(relativePath)) ignored = !rule.negated;
  }
  return ignored;
}

function normalizeDirectoryRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  return relative || ".";
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function fuzzyScore(relativePath: string, query: string): number | null {
  const normalizedPath = relativePath.toLocaleLowerCase();
  const basename = path.posix.basename(normalizedPath);
  if (!query) return relativePath.split("/").length * 10 + relativePath.length / 1_000;
  if (basename === query) return 0;
  if (basename.startsWith(query)) return 10 + basename.length / 1_000;
  const basenameIndex = basename.indexOf(query);
  if (basenameIndex >= 0) return 100 + basenameIndex;
  if (normalizedPath.startsWith(query)) return 200 + normalizedPath.length / 1_000;
  const pathIndex = normalizedPath.indexOf(query);
  if (pathIndex >= 0) return 300 + pathIndex;

  let cursor = 0;
  let gaps = 0;
  for (const character of query) {
    const index = normalizedPath.indexOf(character, cursor);
    if (index < 0) return null;
    gaps += index - cursor;
    cursor = index + 1;
  }
  return 1_000 + gaps;
}
