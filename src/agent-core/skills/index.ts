import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CatalogSkill, ListSkillSummariesOptions, SkillOrigin, SkillSummaryPage } from "./types.js";
import { loadSkillPackage, loadSkillsDir } from "./loadSkillsDir.js";
import { SkillCatalogCache } from "./catalog-cache.js";

export * from "./types.js";
export { loadSkillPackage, loadSkillsDir } from "./loadSkillsDir.js";
export { SkillCatalogCache } from "./catalog-cache.js";

export interface SkillCatalogOptions {
  actlHome: string;
  /** Override the summary cache file location for tests. */
  cachePath?: string;
}

/** Catalog of folders manually installed in <ACTL_AGENT_HOME>/skills. */
export class SkillCatalog {
  private readonly cache: SkillCatalogCache;

  constructor(private readonly options: SkillCatalogOptions) {
    this.cache = new SkillCatalogCache(options.cachePath ?? path.join(options.actlHome, ".cache", "skills-catalog.json"));
  }

  get skillsDirectory(): string {
    return path.join(this.options.actlHome, "skills");
  }

  async listSkills(_projectCwd: string | null = null): Promise<CatalogSkill[]> {
    return loadSkillsDir(this.skillsDirectory, { origin: localOrigin() });
  }

  async listSkillSummaries(
    _projectCwd: string | null = null,
    options: ListSkillSummariesOptions = {},
  ): Promise<SkillSummaryPage> {
    const skills = await this.loadSkillSummariesCached();
    const filtered = filterSummaries(skills, options.query, options.category);
    const total = filtered.length;
    const page = Math.max(1, options.page ?? 1);
    const limit = options.limit ?? total;
    await this.cache.flush();
    return { data: filtered.slice((page - 1) * limit, page * limit), total, page, limit };
  }

  async findSkill(id: string, _projectCwd: string | null = null): Promise<CatalogSkill | null> {
    const summaries = await this.listSkillSummaries();
    const match = summaries.data.find((skill) => skill.id === id);
    if (!match) return null;
    return loadSkillPackage(match.origin.location, { ...localOrigin(), location: match.origin.location });
  }

  private async loadSkillSummariesCached(): Promise<CatalogSkill[]> {
    let entries;
    try {
      entries = await readdir(this.skillsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    const skills: CatalogSkill[] = [];
    const directories = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const directory of directories) {
      const rootPath = path.join(this.skillsDirectory, directory.name);
      const skillFilePath = path.join(rootPath, "SKILL.md");
      try {
        const fileStat = await stat(skillFilePath) as Stats;
        const cached = await this.cache.get(rootPath, fileStat);
        if (cached) {
          skills.push(cached);
          continue;
        }
        const loaded = await loadSkillPackage(rootPath, { ...localOrigin(), location: rootPath }, "summary");
        await this.cache.set(rootPath, fileStat, "", loaded);
        skills.push(loaded);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        skills.push(await loadSkillPackage(rootPath, { ...localOrigin(), location: rootPath }, "summary"));
      }
    }
    return skills;
  }
}

function localOrigin(): Omit<SkillOrigin, "location"> {
  return { provider: "actl", scope: "user" };
}

function filterSummaries(skills: CatalogSkill[], query?: string, category?: string): CatalogSkill[] {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  const normalizedCategory = category?.trim().toLocaleLowerCase();
  return skills.filter((skill) => {
    if (normalizedCategory && skill.category?.toLocaleLowerCase() !== normalizedCategory
      && !skill.tags?.some((tag) => tag.toLocaleLowerCase() === normalizedCategory)) return false;
    if (!normalizedQuery) return true;
    return [skill.name, skill.description, skill.category, ...(skill.tags ?? [])]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
