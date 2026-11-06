import type {
  AgentInputContent, AgentPermissionMode, AgentResponse, AgentRuntimeCapabilities, AgentRuntimeKind,
  CreateRuntimeProviderAccount, PermissionDecision, RuntimeModel, RuntimeModelCatalog, RuntimeModelConfig,
  RuntimeProviderAccount, RuntimeReasoningEffort, AgentProject, AgentSession,
  RuntimeSkill, RuntimeSkillContext, RuntimeStoredFile, RuntimeStreamEvent, RuntimeWorkspaceFileSearchResult,
  RuntimeWorkspaceTree,
  RuntimeWebSearchResult, RuntimeWebSearchSettings, RuntimePromptSettings,
  RuntimeMcpServer, RuntimeMcpServerConfig, RuntimeMcpCatalogServer,
  SessionContext,
} from "../types";
import { localClient } from "./local/service";

export { RuntimeRequestError } from "./local/service";

export interface AgentRuntimeClient {
  readonly kind: AgentRuntimeKind;
  readonly capabilities: AgentRuntimeCapabilities;
  getBaseUrl(): string;

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
  bindSessionToProject(sessionId: string, projectId: string): Promise<AgentSession>;
  deleteSession(sessionId: string): Promise<void>;
  getContext(sessionId: string): Promise<SessionContext>;
  compactSession(sessionId: string, model: string, reasoningEffort?: RuntimeReasoningEffort): Promise<{ compressed: boolean; summarized_run_count: number }>;

  //#endregion


  //#region model

  listModels(sessionId?: string): Promise<RuntimeModelCatalog>;
  listProviderAccounts(): Promise<RuntimeProviderAccount[]>;
  createProviderAccount(config: CreateRuntimeProviderAccount): Promise<RuntimeProviderAccount>;
  updateProviderAccount(accountId: string, config: Pick<CreateRuntimeProviderAccount, "displayName" | "baseURL">): Promise<RuntimeProviderAccount>;
  replaceProviderCredential(accountId: string, apiKey: string): Promise<void>;
  deleteProviderAccount(accountId: string): Promise<void>;
  clearProviderCredential(accountId: string): Promise<void>;
  createModel(accountId: string, model: RuntimeModelConfig): Promise<RuntimeModel>;
  updateModel(modelTargetId: string, model: RuntimeModelConfig): Promise<RuntimeModel>;
  deleteModel(modelTargetId: string): Promise<void>;
  setModelPreference(modelTargetId: string | null, reasoningEffort?: RuntimeReasoningEffort): Promise<void>;

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

  //#endregion


  //#region file

  uploadFile(sessionId: string, file: File, filename?: string): Promise<RuntimeStoredFile>;
  getFileContent(sessionId: string, fileId: string): Promise<Blob>;

  //#endregion


  //#region workspace
  
  searchWorkspaceFiles(projectId: string, query?: string, limit?: number): Promise<RuntimeWorkspaceFileSearchResult>;
  listWorkspaceDirectory(projectId: string, path?: string, maxEntries?: number): Promise<RuntimeWorkspaceTree>;
  
  //#endregion


  //#region responses

  streamResponse(
    sessionId: string, 
    model: string, 
    content: AgentInputContent[], 
    reasoningEffort: RuntimeReasoningEffort | undefined, 
    permissionMode: AgentPermissionMode, 
    onEvent: (event: RuntimeStreamEvent) => void, 
    signal?: AbortSignal
  ): Promise<unknown>;
  cancelResponse(sessionId: string, responseId: string): Promise<AgentResponse>;
  streamPermission(
    sessionId: string, 
    responseId: string, 
    batchId: string, 
    decisions: PermissionDecision[], 
    onEvent: (event: RuntimeStreamEvent) => void, 
    signal?: AbortSignal
  ): Promise<unknown>;

  //#endregion
}


export function getAgentRuntimeClient(kind: AgentRuntimeKind): AgentRuntimeClient {
  void kind;
  return localClient;
}

export function getAgentRuntimeContext(kind: AgentRuntimeKind) {
  return { kind, client: getAgentRuntimeClient(kind) };
}
