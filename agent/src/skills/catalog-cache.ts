import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogSkill } from "./types.js";

const CACHE_VERSION = 1;

export interface SkillStat {
  mtimeMs: number;
  size: number;
}

interface CachedSkillEntry {
  mtimeMs: number;
  size: number;
  digest: string;
  summary: CatalogSkill;
}

interface CacheFile {
  version: number;
  entries: Record<string, CachedSkillEntry>;
}

/**
 * On-disk cache of lightweight skill summaries keyed by the absolute skill
 * directory path. Entries are reused only when the SKILL.md mtime and size
 * are unchanged, so a cache hit avoids re-reading and re-parsing every
 * manifest on list requests (matters once the catalog reaches hundreds of
 * skills). Writes are serialized and atomic (tmp file + rename).
 */
export class SkillCatalogCache {
  private loaded = false;
  private dirty = false;
  private readonly entries = new Map<string, CachedSkillEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly cachePath: string) {}

  async get(rootPath: string, stat: SkillStat): Promise<CatalogSkill | undefined> {
    await this.load();
    const entry = this.entries.get(cacheKey(rootPath));
    if (!entry) return undefined;
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return undefined;
    return structuredClone(entry.summary);
  }

  async set(rootPath: string, stat: SkillStat, digest: string, summary: CatalogSkill): Promise<void> {
    await this.load();
    this.entries.set(cacheKey(rootPath), {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      digest,
      summary: structuredClone(summary),
    });
    this.dirty = true;
  }

  async invalidate(rootPath: string): Promise<void> {
    await this.load();
    if (this.entries.delete(cacheKey(rootPath))) this.dirty = true;
  }

  async flush(): Promise<void> {
    await this.load();
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = new Map(this.entries);
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.write(snapshot));
    await this.writeQueue;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== "object") return;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (isCacheEntry(entry)) this.entries.set(key, entry);
      }
    } catch {
      // Missing or corrupt cache: start empty; it will be rebuilt on demand.
    }
  }

  private async write(snapshot: Map<string, CachedSkillEntry>): Promise<void> {
    try {
      await mkdir(path.dirname(this.cachePath), { recursive: true });
      const payload: CacheFile = {
        version: CACHE_VERSION,
        entries: Object.fromEntries(snapshot),
      };
      const temporaryPath = `${this.cachePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, this.cachePath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      // Cache write failures must never break skill listing.
    }
  }
}

function cacheKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isCacheEntry(value: unknown): value is CachedSkillEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.mtimeMs === "number"
    && typeof entry.size === "number"
    && typeof entry.digest === "string"
    && typeof entry.summary === "object"
    && entry.summary !== null;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
