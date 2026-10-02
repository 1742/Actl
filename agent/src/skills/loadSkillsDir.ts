import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  CatalogSkill,
  SkillDiagnostic,
  SkillManifest,
  SkillOrigin,
  SkillPackage,
  SkillLoadMode,
} from "./types.js";

const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const manifestSchema = z.looseObject({
  name: z.string().trim().min(1).max(64).regex(skillNamePattern),
  description: z.string().trim().min(1).max(1024),
  license: z.string().trim().min(1).optional(),
  compatibility: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  category: z.string().trim().min(1).max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  version: z.string().trim().min(1).max(32).optional(),
  icon: z.string().trim().min(1).max(512).optional(),
  "allowed-tools": z.string().trim().min(1).optional(),
});

export interface LoadSkillsDirectoryOptions {
  origin: Omit<SkillOrigin, "location">;
  mode?: SkillLoadMode;
}

export interface LoadSkillPackageOptions {
  /**
   * Skip the "manifest name must match parent directory" check. Used while
   * validating archives whose staging directory is not yet the final name.
   */
  skipNameCheck?: boolean;
}

export async function loadSkillsDir(
  skillsDir: string,
  options: LoadSkillsDirectoryOptions = {
    origin: { provider: "actl", scope: "user" },
  },
): Promise<CatalogSkill[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const skills: CatalogSkill[] = [];
  const directories = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of directories) {
    const rootPath = path.join(skillsDir, directory.name);
    const origin: SkillOrigin = { ...options.origin, location: rootPath };
    skills.push(await loadSkillPackage(rootPath, origin, options.mode ?? "full"));
  }
  return skills;
}

export async function loadSkillPackage(
  rootPath: string,
  origin: SkillOrigin,
  mode: SkillLoadMode = "full",
  options: LoadSkillPackageOptions = {},
): Promise<CatalogSkill> {
  const fallbackName = path.basename(rootPath);
  const id = createSkillId(origin, rootPath);
  const diagnostics: SkillDiagnostic[] = [];
  const skillFilePath = path.join(rootPath, "SKILL.md");
  let content: string;
  let canonicalRoot: string;
  try {
    [content, canonicalRoot] = await Promise.all([
      readFile(skillFilePath, "utf8"),
      realpath(rootPath),
    ]);
  } catch (error) {
    diagnostics.push({
      severity: "error",
      code: isMissingFileError(error) ? "skill_file_missing" : "skill_read_failed",
      message: error instanceof Error ? error.message : String(error),
      path: skillFilePath,
    });
    return { id, name: fallbackName, origin, available: false, diagnostics };
  }

  const parsed = parseSkillDocument(content, skillFilePath);
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.manifest || parsed.instructions === undefined) {
    return {
      id,
      name: parsed.name ?? fallbackName,
      ...(parsed.description ? { description: parsed.description } : {}),
      origin,
      available: false,
      diagnostics,
    };
  }

  if (!options.skipNameCheck && parsed.manifest.name !== fallbackName) {
    diagnostics.push({
      severity: "error",
      code: "skill_name_directory_mismatch",
      message: `Skill name "${parsed.manifest.name}" must match parent directory "${fallbackName}".`,
      path: skillFilePath,
    });
  }

  const display = displayFields(parsed.manifest);
  if (mode === "summary") {
    return {
      id,
      name: parsed.manifest.name,
      description: parsed.manifest.description,
      ...display,
      origin: { ...origin, location: canonicalRoot },
      available: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      diagnostics,
    };
  }

  const skillPackage: SkillPackage = {
    id,
    manifest: parsed.manifest,
    rootPath: canonicalRoot,
    skillFilePath: path.join(canonicalRoot, "SKILL.md"),
    instructions: parsed.instructions,
    origin: { ...origin, location: canonicalRoot },
    contentDigest: createHash("sha256").update(content, "utf8").digest("hex"),
  };
  if (parsed.manifest.allowedTools) {
    diagnostics.push({
      severity: "warning",
      code: "skill_allowed_tools_not_preapproved",
      message: "The experimental allowed-tools field is preserved but does not grant or restrict Actl Agent permissions.",
      path: skillFilePath,
    });
  }
  return {
    id,
    name: parsed.manifest.name,
    description: parsed.manifest.description,
    ...display,
    origin: skillPackage.origin,
    available: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    diagnostics,
    package: skillPackage,
  };
}

interface ParsedSkillDocument {
  name?: string;
  description?: string;
  manifest?: SkillManifest;
  instructions?: string;
  diagnostics: SkillDiagnostic[];
}

function parseSkillDocument(content: string, skillFilePath: string): ParsedSkillDocument {
  const diagnostics: SkillDiagnostic[] = [];
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    return {
      diagnostics: [{
        severity: "error",
        code: "skill_frontmatter_missing",
        message: "SKILL.md must start with YAML frontmatter.",
        path: skillFilePath,
      }],
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(match[1]!, { prettyErrors: true });
  } catch (error) {
    return {
      diagnostics: [{
        severity: "error",
        code: "skill_frontmatter_invalid_yaml",
        message: error instanceof Error ? error.message : String(error),
        path: skillFilePath,
      }],
    };
  }

  const candidate = isRecord(raw) ? raw : {};
  const name = typeof candidate.name === "string" ? candidate.name : undefined;
  const description = typeof candidate.description === "string" ? candidate.description : undefined;
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    diagnostics.push(...result.error.issues.map((issue): SkillDiagnostic => ({
      severity: "error",
      code: "skill_manifest_invalid",
      message: `${issue.path.join(".") || "frontmatter"}: ${issue.message}`,
      path: skillFilePath,
    })));
    return {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      diagnostics,
    };
  }

  const instructions = match[2]!.trim();
  if (!instructions) {
    diagnostics.push({
      severity: "error",
      code: "skill_instructions_empty",
      message: "SKILL.md must contain Markdown instructions after its frontmatter.",
      path: skillFilePath,
    });
  }

  const {
    name: parsedName,
    description: parsedDescription,
    license,
    compatibility,
    metadata,
    category,
    tags,
    version,
    icon,
    "allowed-tools": allowedTools,
    ...extensions
  } = result.data;
  return {
    name: parsedName,
    description: parsedDescription,
    manifest: {
      name: parsedName,
      description: parsedDescription,
      ...(license === undefined ? {} : { license }),
      ...(compatibility === undefined ? {} : { compatibility }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(category === undefined ? {} : { category }),
      ...(tags === undefined ? {} : { tags }),
      ...(version === undefined ? {} : { version }),
      ...(icon === undefined ? {} : { icon }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      extensions,
    },
    instructions,
    diagnostics,
  };
}

function displayFields(manifest: SkillManifest): {
  category?: string;
  tags?: readonly string[];
  version?: string;
  icon?: string;
} {
  return {
    ...(manifest.category === undefined ? {} : { category: manifest.category }),
    ...(manifest.tags === undefined ? {} : { tags: manifest.tags }),
    ...(manifest.version === undefined ? {} : { version: manifest.version }),
    ...(manifest.icon === undefined ? {} : { icon: manifest.icon }),
  };
}

function createSkillId(origin: SkillOrigin, rootPath: string): string {
  const digest = createHash("sha256")
    .update(`${origin.provider}\0${origin.scope}\0${path.resolve(rootPath)}`)
    .digest("hex")
    .slice(0, 24);
  return `skill_${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
