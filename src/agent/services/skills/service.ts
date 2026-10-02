import { useRuntimeStore } from '../../../stores/runtime';
import { tr } from '../../../i18n';
import type { RuntimeSkill, RuntimeSkillCatalog } from '../../types';

export interface LocalSkillsQuery {
  q?: string;
  category?: string;
  page?: number;
  limit?: number;
}

export interface SkillDetail extends RuntimeSkill {
  files?: {
    root: string;
    skill: string;
    entries: Array<{ path: string; type: 'file' | 'directory' }>;
  };
  languages?: string[];
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function fetchLocalSkills(
  baseUrl: string,
  query: LocalSkillsQuery = {},
): Promise<RuntimeSkillCatalog> {
  const search = new URLSearchParams();
  if (query.q) search.set('q', query.q);
  if (query.category) search.set('category', query.category);
  if (query.page) search.set('page', String(query.page));
  if (query.limit) search.set('limit', String(query.limit));
  const runtime = useRuntimeStore();
  const response = await fetch(`${joinUrl(baseUrl, '/skills')}${search.size ? `?${search}` : ''}`, {
    headers: runtime.agentToken ? { 'X-Actl-Agent-Token': runtime.agentToken } : {},
  });
  const payload = (await response.json()) as RuntimeSkillCatalog | { error?: { message?: string } };
  if (!response.ok)
    throw new Error(
      (payload as { error?: { message?: string } }).error?.message ??
        tr('dynamic.skillRequestFailed', { status: response.status }),
    );
  return payload as RuntimeSkillCatalog;
}

export async function fetchSkillDetail(baseUrl: string, skillId: string): Promise<SkillDetail> {
  const runtime = useRuntimeStore();
  const response = await fetch(joinUrl(baseUrl, `/skills/${encodeURIComponent(skillId)}`), {
    headers: runtime.agentToken ? { 'X-Actl-Agent-Token': runtime.agentToken } : {},
  });
  const payload = (await response.json()) as SkillDetail | { error?: { message?: string } };
  if (!response.ok)
    throw new Error(
      (payload as { error?: { message?: string } }).error?.message ??
        tr('dynamic.skillRequestFailed', { status: response.status }),
    );
  return payload as SkillDetail;
}
