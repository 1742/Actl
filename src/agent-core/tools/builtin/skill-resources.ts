import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SkillCatalog } from "../../skills/index.js";
import type { CatalogSkill, SkillPackage } from "../../skills/types.js";
import { isPathInside } from "../path-security.js";
import type {
  ToolCallContext,
  ToolDefinition,
  ToolPermissionRequirement,
  ToolProvider,
} from "../registry.js";

const DEFAULT_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_SEARCH_LIMIT = 20;

const searchSkillsInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe("Optional terms to match against Skill names, descriptions, categories, and tags."),
  limit: z.number().int().min(1).max(100).optional().describe(`Maximum matches to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
}).strict();

const getSkillInstructionsInputSchema = z.object({
  skillId: z.string().trim().min(1).describe("ID of the Skill whose complete workflow instructions should be loaded."),
}).strict();

const listSkillFilesInputSchema = z.object({
  skillId: z.string().trim().min(1).describe("ID of the installed Skill to inspect."),
  path: z.string().trim().min(1).optional().describe(
    "Optional path relative to the Skill package root. Omit to list the whole Skill structure.",
  ),
  depth: z.number().int().min(0).max(12).optional().describe(
    `Maximum directory depth. Defaults to ${DEFAULT_DEPTH}.`,
  ),
  maxEntries: z.number().int().min(1).max(2_000).optional().describe(
    `Maximum number of returned entries. Defaults to ${DEFAULT_MAX_ENTRIES}.`,
  ),
  includeHidden: z.boolean().optional().describe("Include dot-prefixed files and directories."),
}).strict();

interface SkillFileEntry {
  path: string;
  absolutePath: string;
  type: "file" | "directory" | "symlink" | "other";
  sizeBytes?: number;
}

export class SkillDiscoveryToolProvider implements ToolProvider {
  readonly name = "builtin-skill-discovery";

  constructor(private readonly skillCatalog: SkillCatalog) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "search_skills",
        description: "Search the installed Agent Skills available to the current workspace. Returns lightweight IDs, names, and descriptions; use get_skill_instructions to load a relevant Skill's complete workflow.",
        inputSchema: searchSkillsInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "get_skill_instructions",
        description: "Load the complete SKILL.md workflow for an installed Agent Skill. Use this for a user-selected Skill reference or a relevant result from search_skills before following its specialized workflow.",
        inputSchema: getSkillInstructionsInputSchema,
        execution: { concurrency: "parallel" },
      },
      {
        name: "list_skill_files",
        description: "List the files, resource directories, and script paths bundled with an installed Agent Skill. Use this only when the Skill workflow needs bundled resources or scripts, then use filesystem or shell tools with the returned paths.",
        inputSchema: listSkillFilesInputSchema,
        execution: { concurrency: "parallel" },
      },
    ];
  }

  async getPermissionRequirement(
    name: string,
    input: unknown,
    context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    if (name === "search_skills") {
      return { capability: "skill.read", resource: "skill-catalog", action: "list" };
    }
    if (name === "get_skill_instructions") {
      const parsed = input as z.infer<typeof getSkillInstructionsInputSchema>;
      const skill = await this.resolveAvailableSkill(parsed.skillId, context.cwd);
      return { capability: "filesystem.read", resource: skill.skillFilePath, action: "read" };
    }
    if (name === "list_skill_files") {
      const parsed = input as z.infer<typeof listSkillFilesInputSchema>;
      const skill = await this.resolveAvailableSkill(parsed.skillId, context.cwd);
      const target = await resolveSkillPath(skill.rootPath, parsed.path);
      return { capability: "filesystem.read", resource: target, action: "list" };
    }
    throw new Error(`Unsupported Skill tool: ${name}`);
  }

  async callTool(name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    if (name === "search_skills") {
      assertAuthorization(context, "skill.read", "skill-catalog", "list");
      const parsed = input as z.infer<typeof searchSkillsInputSchema>;
      const query = parsed.query?.toLocaleLowerCase();
      const matches = (await this.skillCatalog.listSkills(context.cwd))
        .filter((skill) => skill.available && skill.package)
        .filter((skill) => !query || skillSearchText(skill).includes(query));
      const limit = parsed.limit ?? DEFAULT_SEARCH_LIMIT;
      return {
        skills: matches.slice(0, limit).map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          ...(skill.category ? { category: skill.category } : {}),
          ...(skill.tags?.length ? { tags: skill.tags } : {}),
        })),
        total: matches.length,
        truncated: matches.length > limit,
      };
    }
    if (name === "get_skill_instructions") {
      const parsed = input as z.infer<typeof getSkillInstructionsInputSchema>;
      const skill = await this.resolveAvailableSkill(parsed.skillId, context.cwd);
      assertAuthorization(context, "filesystem.read", skill.skillFilePath, "read");
      return {
        skillId: skill.id,
        name: skill.manifest.name,
        description: skill.manifest.description,
        instructions: skill.instructions,
        packageRoot: skill.rootPath,
        contentDigest: skill.contentDigest,
        resourceHint: `Use list_skill_files with skillId "${skill.id}" only when bundled resources or scripts are needed.`,
      };
    }
    if (name !== "list_skill_files") throw new Error(`Unsupported Skill tool: ${name}`);
    const parsed = input as z.infer<typeof listSkillFilesInputSchema>;
    const skill = await this.resolveAvailableSkill(parsed.skillId, context.cwd);
    const skillRoot = await realpath(skill.rootPath);
    const target = await resolveSkillPath(skill.rootPath, parsed.path);
    assertAuthorization(context, "filesystem.read", target, "list");

    const targetInfo = await lstat(target);
    const entries: SkillFileEntry[] = [];
    const maxEntries = parsed.maxEntries ?? DEFAULT_MAX_ENTRIES;
    let truncated = false;
    if (targetInfo.isDirectory()) {
      truncated = await walkSkillDirectory({
        directory: target,
        skillRoot,
        depth: parsed.depth ?? DEFAULT_DEPTH,
        maxEntries,
        includeHidden: parsed.includeHidden ?? false,
        entries,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } else {
      entries.push(toEntry(skillRoot, target, targetInfo));
    }

    return {
      skillId: parsed.skillId,
      skillRoot,
      listedPath: target,
      entries,
      truncated,
    };
  }

  private async resolveAvailableSkill(skillId: string, cwd: string | null): Promise<SkillPackage> {
    const entry = await this.skillCatalog.findSkill(skillId, cwd);
    if (!entry) throw new Error(`Skill not found: ${skillId}`);
    if (!entry.available || !entry.package) {
      const reason = entry.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
      throw new Error(reason || `Skill is unavailable: ${entry.name}`);
    }
    return entry.package;
  }
}

async function walkSkillDirectory(options: {
  directory: string;
  skillRoot: string;
  depth: number;
  maxEntries: number;
  includeHidden: boolean;
  entries: SkillFileEntry[];
  signal?: AbortSignal;
}): Promise<boolean> {
  options.signal?.throwIfAborted();
  const children = await readdir(options.directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    options.signal?.throwIfAborted();
    if (!options.includeHidden && child.name.startsWith(".")) continue;
    if (options.entries.length >= options.maxEntries) return true;
    const absolutePath = path.join(options.directory, child.name);
    const info = await lstat(absolutePath);
    options.entries.push(toEntry(options.skillRoot, absolutePath, info));
    if (info.isDirectory() && !info.isSymbolicLink() && options.depth > 0) {
      const truncated = await walkSkillDirectory({ ...options, directory: absolutePath, depth: options.depth - 1 });
      if (truncated) return true;
    }
  }
  return false;
}

function toEntry(skillRoot: string, absolutePath: string, info: Stats): SkillFileEntry {
  const type = info.isSymbolicLink()
    ? "symlink"
    : info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : "other";
  return {
    path: normalizeRelativePath(path.relative(skillRoot, absolutePath)),
    absolutePath,
    type,
    ...(info.isFile() ? { sizeBytes: info.size } : {}),
  };
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/") || ".";
}

async function resolveSkillPath(
  packageRoot: string,
  relativePath?: string,
): Promise<string> {
  const root = await realpath(packageRoot);
  if (!relativePath) return root;
  if (path.isAbsolute(relativePath)) throw new Error("Skill paths must be relative.");
  const target = await realpath(path.resolve(root, relativePath));
  if (!isPathInside(root, target)) throw new Error("Skill path escapes the active Skill package.");
  return target;
}

function assertAuthorization(
  context: ToolCallContext,
  capability: string,
  resource: string,
  action: string,
): void {
  const requirement = context.authorization?.requirement;
  if (!requirement
    || requirement.capability !== capability
    || requirement.action !== action
    || requirement.resource !== resource) {
    throw new Error("Skill discovery tool does not have authorization for this operation.");
  }
}

function skillSearchText(skill: CatalogSkill): string {
  return [
    skill.name,
    skill.description,
    skill.category,
    ...(skill.tags ?? []),
  ].filter((value): value is string => Boolean(value)).join("\n").toLocaleLowerCase();
}
