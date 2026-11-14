import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { reasoningEfforts } from "../../../shared/agent/models.js";
import type { AgentProfile } from "../../../shared/agent/profiles.js";

const profileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const frontmatterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  modelTargetId: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
}).strict();

export const agentProfileSchema = frontmatterSchema.extend({
  id: profileIdSchema,
  instructions: z.string().trim().min(1).max(30_000),
});

export const DEFAULT_AGENT_PROFILE: AgentProfile = Object.freeze({
  id: "general",
  name: "General",
  description: "Investigate a read-only task and report findings with evidence.",
  instructions: "Work toward the assigned deliverable. Identify the evidence for your findings and any limits on what you verified.",
});

const builtInProfiles: readonly AgentProfile[] = [
  DEFAULT_AGENT_PROFILE,
  {
    id: "explore",
    name: "Explore",
    description: "Trace code, data flow, or behavior through the workspace.",
    instructions: "Find relevant entry points, trace the paths that execute, and report the supporting files and line locations. Distinguish observed behavior from inferred behavior.",
  },
  {
    id: "review",
    name: "Review",
    description: "Review changes or existing code for correctness and regressions.",
    instructions: "Prioritize actionable findings. For each finding, cite its location, explain the conditions that trigger it and its impact, and identify a useful verification step.",
  },
];

export class AgentProfileCatalog {
  constructor(private readonly homeDirectory?: string) {}

  async list(): Promise<AgentProfile[]> {
    const files = await this.profileFiles();
    const profiles = builtInProfiles.filter(({ id }) => !files.has(id));
    for (const [id, matches] of files) {
      try {
        profiles.push(await this.readProfile(id, matches));
      } catch {
        // Unavailable profiles are omitted from discovery. Resolving an ID still reports its error.
      }
    }
    return profiles.sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolve(profileId = DEFAULT_AGENT_PROFILE.id): Promise<AgentProfile> {
    const id = profileIdSchema.parse(profileId);
    const files = (await this.profileFiles()).get(id);
    if (files) return this.readProfile(id, files);
    const builtIn = builtInProfiles.find((profile) => profile.id === id);
    if (!builtIn) throw new Error(`Agent profile "${id}" was not found.`);
    return builtIn;
  }

  /** Return the id and the path for files with the same name (case-insensitive) */
  private async profileFiles(): Promise<Map<string, string[]>> {
    const files = new Map<string, string[]>();
    if (!this.homeDirectory) return files;
    const directory = path.join(this.homeDirectory, "agents");
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      const id = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
      if (!profileIdSchema.safeParse(id).success) continue;
      const matches = files.get(id) ?? [];
      matches.push(path.join(directory, entry.name));
      files.set(id, matches);
    }
    return files;
  }

  private async readProfile(id: string, files: string[]): Promise<AgentProfile> {
    const [file] = files;
    if (!file || files.length !== 1) throw new Error(`Agent profile "${id}" has multiple Markdown files.`);
    try {
      const content = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
      const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
      if (!match) throw new Error("Start the file with YAML frontmatter and close it with ---.");
      const frontmatter = frontmatterSchema.parse(parseYaml(match[1]!));
      return agentProfileSchema.parse({ ...frontmatter, id, instructions: match[2] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot load agent profile "${id}" from ${path.basename(file)}: ${message}`, { cause: error });
    }
  }
}
