import { desktopRequest } from '../desktopTransport';
import type { RuntimeSkill, RuntimeSkillCatalog } from '../../types';
export interface LocalSkillsQuery { q?: string; category?: string; page?: number; limit?: number }
export interface SkillDetail extends RuntimeSkill {
  files?: { root: string; skill: string; entries: Array<{ path: string; type: 'file' | 'directory' }> };
  languages?: string[];
}
export async function fetchLocalSkills(_baseUrl: string, query: LocalSkillsQuery = {}): Promise<RuntimeSkillCatalog> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) search.set(key, String(value));
  return desktopRequest(`/skills${search.size ? `?${search}` : ''}`);
}
export async function fetchSkillDetail(_baseUrl: string, skillId: string): Promise<SkillDetail> {
  return desktopRequest(`/skills/${encodeURIComponent(skillId)}`);
}
