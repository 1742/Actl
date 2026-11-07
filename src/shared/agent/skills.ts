interface RuntimeSkillDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface RuntimeSkill {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: readonly string[];
  version?: string;
  icon?: string;
  source: {
    provider: string;
    scope: string;
    location: string;
  };
  available: boolean;
  diagnostics: RuntimeSkillDiagnostic[];
}

export interface RuntimeSkillCatalog {
  data: RuntimeSkill[];
  total: number;
  page: number;
  limit: number;
}

export interface RuntimeSkillContext {
  projectId?: string;
  sessionId?: string;
}

export interface SkillDetail extends RuntimeSkill {
  files?: { root: string; skill: string; entries: SkillFileDto[] };
  manifest?: SkillManifestDto;
  content_digest?: string;
  languages?: string[];
}

export interface SkillFileDto {
  path: string;
  type: "file" | "directory";
}

interface SkillManifestDto {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  category?: string;
  tags?: readonly string[];
  version?: string;
  icon?: string;
  allowedTools?: string;
  extensions: Record<string, unknown>;
}
