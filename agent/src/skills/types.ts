export type SkillProvider = "actl";
export type SkillScope = "user";

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /**
   * Actl Agent display extensions. These fields are additive and do not
   * belong to the open Agent Skills spec; unknown consumers must ignore them.
   */
  category?: string;
  tags?: readonly string[];
  version?: string;
  icon?: string;
  /**
   * Experimental Agent Skills field. It is preserved as a host hint and never
   * grants permissions or narrows the runtime tool list by itself.
   */
  allowedTools?: string;
  extensions: Record<string, unknown>;
}

export interface SkillOrigin {
  provider: SkillProvider;
  scope: SkillScope;
  location: string;
}

export interface SkillPackage {
  id: string;
  manifest: SkillManifest;
  rootPath: string;
  skillFilePath: string;
  instructions: string;
  origin: SkillOrigin;
  contentDigest: string;
}

export interface SkillDiagnostic {
  severity: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface CatalogSkill {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: readonly string[];
  version?: string;
  icon?: string;
  origin: SkillOrigin;
  available: boolean;
  diagnostics: SkillDiagnostic[];
  package?: SkillPackage;
}

export interface ListSkillSummariesOptions {
  query?: string;
  category?: string;
  /** 1-based page number; default 1. */
  page?: number;
  /** Items per page; default returns all matches. */
  limit?: number;
}

export interface SkillSummaryPage {
  data: CatalogSkill[];
  total: number;
  page: number;
  limit: number;
}

/** Loader granularity. "summary" skips host metadata and runtime detection. */
export type SkillLoadMode = "full" | "summary";

export const MAX_EXPLICIT_SKILLS = 8;
