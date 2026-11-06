import { desktopRequest } from '../desktopTransport';
import type { RuntimeSkill, RuntimeSkillCatalog } from '../../types';
export interface LocalSkillsQuery { q?: string; category?: string; page?: number; limit?: number; sessionId?: string; projectId?: string }
export interface SkillDetail extends RuntimeSkill {
  files?: { root: string; skill: string; entries: Array<{ path: string; type: 'file' | 'directory' }> };
  languages?: string[];
}

export async function fetchLocalSkills(query: LocalSkillsQuery = {}): Promise<RuntimeSkillCatalog> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (value !== undefined) values[key] = String(value);
  return desktopRequest({ operation: 'skills.list', query: values });
}

export async function fetchSkillDetail(skillId: string): Promise<SkillDetail> {
  return desktopRequest({ operation: 'skills.detail', params: { skillId } });
}
