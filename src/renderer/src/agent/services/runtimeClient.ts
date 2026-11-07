import type {
  ResponseInputPartDto, PermissionMode, AgentResponseDto, PermissionResolutionDto, AgentStreamEvent,
} from '../../../../shared/agent/responses';
import type {
  CreateRuntimeProviderAccount, RuntimeModelCatalog, RuntimeModelConfig, RuntimeProviderAccount,
  ReasoningEffort,
} from '../../../../shared/agent/models';
import type { AgentProject, AgentSession, SessionContext } from '../../../../shared/agent/sessions';
import type { RuntimeSkill, RuntimeSkillContext, SkillDetail } from '../../../../shared/agent/skills';
import type { RuntimeStoredFile } from '../../../../shared/agent/files';
import type { RuntimeWorkspaceFileSearchResult, RuntimeWorkspaceTree, WorkspaceFilePreview } from '../../../../shared/agent/workspace';
import type { RuntimeWebSearchResult, RuntimeWebSearchSettings } from '../../../../shared/agent/web-search';
import type { RuntimePromptSettings } from '../../../../shared/agent/prompts';
import type { RuntimeMcpServer, RuntimeMcpServerConfig, RuntimeMcpCatalogServer } from '../../../../shared/agent/mcp';
import { localClient } from "./localClient";
import type { SessionReview } from '../../../../shared/agent/review';

export type AgentRuntimeKind = "local";

export interface AgentRuntimeCapabilities {
  modelConfiguration: boolean;
  skills: boolean;
  workspace: boolean;
  uploadFile: boolean;
  permissions: boolean;
  localProjectPaths: boolean;
}

export { RuntimeRequestError } from "./desktopTransport";

export interface AgentRuntimeClient {
  readonly kind: AgentRuntimeKind;
  readonly capabilities: AgentRuntimeCapabilities;

  //#region project

  listProjects(): Promise<AgentProject[]>;
  createProject(value: string): Promise<AgentProject>;
  deleteProject(projectId: string): Promise<void>;
  
  //#endregion


  //#region mcp

  listMcpServers(): Promise<RuntimeMcpServer[]>;
  listMcpCatalog(): Promise<RuntimeMcpCatalogServer[]>;
  saveMcpServer(name: string, config: RuntimeMcpServerConfig): Promise<RuntimeMcpServer>;
  deleteMcpServer(name: string): Promise<void>;
  testMcpServer(name: string, config: RuntimeMcpServerConfig): Promise<{ tools: RuntimeMcpServer["tools"] }>;

  //#endregion

  
  //#region session
  
  listSessions(): Promise<AgentSession[]>;
  createSession(projectId?: string): Promise<AgentSession>;
  renameSession(sessionId: string, title: string | null): Promise<AgentSession>;
  deleteSession(sessionId: string): Promise<void>;
  getContext(sessionId: string): Promise<SessionContext>;
  getSessionReview(sessionId: string, options?: { fileId?: string; runId?: string }): Promise<SessionReview>;
  compactSession(sessionId: string, model: string, reasoningEffort?: ReasoningEffort): Promise<{ compressed: boolean; summarized_run_count: number }>;

  //#endregion


  //#region model

  listModels(sessionId?: string): Promise<RuntimeModelCatalog>;
  listProviderAccounts(): Promise<RuntimeProviderAccount[]>;
  createProviderAccount(config: CreateRuntimeProviderAccount): Promise<RuntimeProviderAccount>;
  updateProviderAccount(accountId: string, config: Pick<CreateRuntimeProviderAccount, "displayName" | "baseURL">): Promise<RuntimeProviderAccount>;
  replaceProviderCredential(accountId: string, apiKey: string): Promise<void>;
  deleteProviderAccount(accountId: string): Promise<void>;
  clearProviderCredential(accountId: string): Promise<void>;
  createModel(accountId: string, model: RuntimeModelConfig): Promise<{ id: string }>;
  updateModel(modelTargetId: string, model: RuntimeModelConfig): Promise<{ id: string }>;
  deleteModel(modelTargetId: string): Promise<void>;
  setModelPreference(modelTargetId: string | null, reasoningEffort?: ReasoningEffort): Promise<void>;

  //#endregion


  //#region web search

  getPromptSettings(): Promise<RuntimePromptSettings>;
  getDefaultPromptSettings(): Promise<RuntimePromptSettings>;
  savePromptSettings(settings: Pick<RuntimePromptSettings, "revision" | "blocks">): Promise<RuntimePromptSettings>;

  getWebSearchSettings(): Promise<RuntimeWebSearchSettings>;
  saveWebSearchSettings(settings: { enabled: boolean; provider: RuntimeWebSearchSettings["provider"]; mode: RuntimeWebSearchSettings["mode"]; baseUrl?: string; apiKey?: string }): Promise<RuntimeWebSearchSettings>;
  clearWebSearchCredential(): Promise<RuntimeWebSearchSettings>;
  testWebSearch(): Promise<RuntimeWebSearchResult>;

  //#endregion


  //#region skills

  listSkills(context?: RuntimeSkillContext): Promise<RuntimeSkill[]>;
  getSkillDetail(skillId: string): Promise<SkillDetail>;

  //#endregion


  //#region file

  uploadFile(sessionId: string, file: File, filename?: string): Promise<RuntimeStoredFile>;
  getFileContent(sessionId: string, fileId: string): Promise<Blob>;

  //#endregion


  //#region workspace
  
  searchWorkspaceFiles(projectId: string, query?: string, limit?: number): Promise<RuntimeWorkspaceFileSearchResult>;
  listWorkspaceDirectory(projectId: string, path?: string, maxEntries?: number): Promise<RuntimeWorkspaceTree>;
  previewWorkspaceFile(projectId: string, path: string): Promise<WorkspaceFilePreview>;
  
  //#endregion


  //#region responses

  streamResponse(
    sessionId: string, 
    model: string, 
    content: ResponseInputPartDto[],
    reasoningEffort: ReasoningEffort | undefined,
    permissionMode: PermissionMode,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<AgentResponseDto>;
  cancelResponse(sessionId: string, responseId: string): Promise<AgentResponseDto>;
  streamPermission(
    sessionId: string, 
    responseId: string, 
    batchId: string, 
    decisions: PermissionResolutionDto[],
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<AgentResponseDto>;

  //#endregion
}

export function getAgentRuntimeClient(kind: AgentRuntimeKind): AgentRuntimeClient {
  void kind;
  return localClient;
}

export function getAgentRuntimeContext(kind: AgentRuntimeKind) {
  return { kind, client: getAgentRuntimeClient(kind) };
}
