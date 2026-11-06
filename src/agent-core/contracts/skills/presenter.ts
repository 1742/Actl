import { readdir } from "node:fs/promises";
import path from "node:path";
import type { SkillCatalog } from "../../skills/index.js";
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

export async function listSkillFiles(root: string, directory = root, entries: SkillFileDto[] = []): Promise<SkillFileDto[]> {
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

export function inferLanguages(entries: SkillFileDto[]): string[] {
  return [...new Set(entries.filter((entry) => entry.type === "file")
    .map((entry) => languageByExtension[path.extname(entry.path).toLocaleLowerCase()])
    .filter((language): language is string => Boolean(language)))].sort();
}

export function toCatalogDto(skill: Awaited<ReturnType<SkillCatalog["listSkills"]>>[number]) {
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
