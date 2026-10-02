import type { Request, Response } from "express";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SkillCatalog } from "../../skills/index.js";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import { ApiError } from "../common/api-error.js";
import { validated } from "../common/validation.js";
import type { ListSkillsQuery, SkillParams } from "./skill.schemas.js";
import { currentOwnerId } from "../../auth/runtime-auth.js";

export interface SkillHandlerDependencies { skillCatalog: SkillCatalog; workspaceStore: WorkspaceStore; }

export function createSkillHandlers({ skillCatalog, workspaceStore }: SkillHandlerDependencies) {
  const projectCwdFor = async ({ sessionId, projectId }: ListSkillsQuery, response: Response): Promise<string | null> => {
    const ownerId = currentOwnerId(response);
    if (sessionId !== undefined) {
      const session = await workspaceStore.getSession(sessionId, ownerId);
      if (!session) throw new ApiError(404, "session_not_found", "Session not found.");
      return session.cwd;
    }
    if (projectId !== undefined) {
      const project = workspaceStore.getProject(projectId, ownerId);
      if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
      return project.cwd;
    }
    return null;
  };
  return {
    async listSkills(_request: Request, response: Response): Promise<void> {
      const query = validated<ListSkillsQuery>(response, "query");
      const page = await skillCatalog.listSkillSummaries(await projectCwdFor(query, response), {
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(query.category !== undefined ? { category: query.category } : {}),
        ...(query.page !== undefined ? { page: query.page } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      response.json({ data: page.data.map(toCatalogDto), total: page.total, page: page.page, limit: page.limit });
    },
    async getSkill(_request: Request, response: Response): Promise<void> {
      const query = validated<ListSkillsQuery>(response, "query");
      const { skillId } = validated<SkillParams>(response, "params");
      const skill = await skillCatalog.findSkill(skillId, await projectCwdFor(query, response));
      if (!skill) throw new ApiError(404, "skill_not_found", "Skill not found.");
      const fileEntries = skill.package ? await listSkillFiles(skill.package.rootPath) : [];
      response.json({
        ...toCatalogDto(skill),
        ...(skill.package ? {
          manifest: structuredClone(skill.package.manifest),
          files: {
            root: skill.package.rootPath,
            skill: skill.package.skillFilePath,
            entries: fileEntries,
          },
          languages: inferLanguages(fileEntries),
          content_digest: skill.package.contentDigest,
        } : {}),
      });
    },
  };
}

interface SkillFileDto {
  path: string;
  type: "file" | "directory";
}

const MAX_SKILL_FILES = 500;
const languageByExtension: Record<string, string> = {
  ".py": "Python", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".jsx": "JavaScript",
  ".sh": "Shell", ".ps1": "PowerShell", ".rb": "Ruby", ".go": "Go",
  ".rs": "Rust", ".java": "Java", ".cs": "C#", ".php": "PHP",
  ".swift": "Swift", ".kt": "Kotlin", ".r": "R", ".sql": "SQL",
};

async function listSkillFiles(root: string, directory = root, entries: SkillFileDto[] = []): Promise<SkillFileDto[]> {
  if (entries.length >= MAX_SKILL_FILES) return entries;
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (entries.length >= MAX_SKILL_FILES) break;
    const absolutePath = path.join(directory, child.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
    if (child.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      await listSkillFiles(root, absolutePath, entries);
    } else if (child.isFile()) {
      entries.push({ path: relativePath, type: "file" });
    }
  }
  return entries;
}

function inferLanguages(entries: SkillFileDto[]): string[] {
  return [...new Set(entries.filter((entry) => entry.type === "file")
    .map((entry) => languageByExtension[path.extname(entry.path).toLocaleLowerCase()])
    .filter((language): language is string => Boolean(language)))].sort();
}

function toCatalogDto(skill: Awaited<ReturnType<SkillCatalog["listSkills"]>>[number]) {
  return {
    id: skill.id, name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.category === undefined ? {} : { category: skill.category }),
    ...(skill.tags === undefined ? {} : { tags: skill.tags }),
    ...(skill.version === undefined ? {} : { version: skill.version }),
    ...(skill.icon === undefined ? {} : { icon: skill.icon }),
    source: { provider: skill.origin.provider, scope: skill.origin.scope, location: skill.origin.location },
    available: skill.available, diagnostics: structuredClone(skill.diagnostics),
  };
}
