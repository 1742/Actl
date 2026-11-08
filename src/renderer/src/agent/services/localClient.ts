import { desktopRequest as request, desktopStream } from './desktopTransport';
import type { AgentRuntimeClient } from './runtimeClient';
import type {
  ResponseInputPartDto, PermissionMode, AgentResponseDto, PermissionResolutionDto, AgentStreamEvent,
  CreateResponseRequest, ResolvePermissionsRequest,
} from '../../../../shared/agent/responses';
import type { AgentProject, AgentSession, SessionContext } from '../../../../shared/agent/sessions';
import type {
  CreateRuntimeProviderAccount, RuntimeModelCatalog, RuntimeModelConfig, RuntimeProviderAccount,
  ReasoningEffort,
} from '../../../../shared/agent/models';
import type { RuntimeMcpCatalogServer, RuntimeMcpServer, RuntimeMcpServerConfig } from '../../../../shared/agent/mcp';
import type { RuntimePromptSettings } from '../../../../shared/agent/prompts';
import type { RuntimeSkillCatalog, RuntimeSkillContext, SkillDetail } from '../../../../shared/agent/skills';
import type { RuntimeStoredFile } from '../../../../shared/agent/files';
import type { RuntimeWebSearchResult, RuntimeWebSearchSettings } from '../../../../shared/agent/web-search';
import type { RuntimeWorkspaceFileSearchResult, RuntimeWorkspaceTree, WorkspaceFilePreview } from '../../../../shared/agent/workspace';
import type { AgentCommand } from '../../../../shared/agent-ipc';
import type { SessionReview } from '../../../../shared/agent/review';

function stream(command: AgentCommand, onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal) {
  return desktopStream<AgentResponseDto>(command, (event) => {
    if (!event || typeof event !== 'object' || !('type' in event)) throw new Error('Invalid Agent event.');
    onEvent(event);
  }, signal);
}

export class LocalRuntimeClient implements AgentRuntimeClient {
  readonly kind = 'local' as const;
  readonly capabilities = {
    modelConfiguration: true, skills: true, workspace: true, uploadFile: true,
    permissions: true, localProjectPaths: true,
  } as const;

  listProjects() { return request<AgentProject[]>({ operation: 'projects.list' }); }
  createProject(cwd: string) { return request<AgentProject>({ operation: 'projects.create', body: { cwd } }); }
  deleteProject(projectId: string) { return request<void>({ operation: 'projects.delete', params: { projectId } }); }

  listSessions() { return request<AgentSession[]>({ operation: 'sessions.list' }); }
  createSession(projectId?: string) { return request<AgentSession>({ operation: 'sessions.create', body: projectId ? { projectId } : {} }); }
  renameSession(sessionId: string, title: string | null) { return request<AgentSession>({ operation: 'sessions.rename', params: { sessionId }, body: { title } }); }
  deleteSession(sessionId: string) { return request<void>({ operation: 'sessions.delete', params: { sessionId } }); }
  getContext(sessionId: string) { return request<SessionContext>({ operation: 'sessions.context', params: { sessionId } }); }
  getSessionReview(sessionId: string, options?: { fileId?: string; runId?: string }) {
    return request<SessionReview>({
      operation: 'sessions.review', params: { sessionId }, ...(options ? { query: options } : {}),
    });
  }
  compactSession(sessionId: string, model: string, reasoningEffort?: ReasoningEffort) {
    return request<{ compressed: boolean; summarized_run_count: number }>({ operation: 'sessions.compact', params: { sessionId }, body: { model, ...(reasoningEffort ? { reasoningEffort } : {}) } });
  }

  listModels(sessionId?: string) { return request<RuntimeModelCatalog>({ operation: 'models.list', ...(sessionId ? { query: { sessionId } } : {}) }); }
  async listProviderAccounts() { return (await request<{ data: RuntimeProviderAccount[] }>({ operation: 'accounts.list' })).data; }
  createProviderAccount(config: CreateRuntimeProviderAccount) { return request<RuntimeProviderAccount>({ operation: 'accounts.create', body: config }); }
  updateProviderAccount(accountId: string, config: Pick<CreateRuntimeProviderAccount, 'displayName' | 'baseURL'>) { return request<RuntimeProviderAccount>({ operation: 'accounts.update', params: { accountId }, body: config }); }
  replaceProviderCredential(accountId: string, apiKey: string) { return request<void>({ operation: 'accounts.credential.replace', params: { accountId }, body: { apiKey } }); }
  clearProviderCredential(accountId: string) { return request<void>({ operation: 'accounts.credential.clear', params: { accountId } }); }
  deleteProviderAccount(accountId: string) { return request<void>({ operation: 'accounts.delete', params: { accountId } }); }
  createModel(accountId: string, model: RuntimeModelConfig) { return request<{ id: string }>({ operation: 'models.create', params: { accountId }, body: model }); }
  updateModel(modelTargetId: string, model: RuntimeModelConfig) { return request<{ id: string }>({ operation: 'models.update', params: { modelTargetId }, body: model }); }
  deleteModel(modelTargetId: string) { return request<void>({ operation: 'models.delete', params: { modelTargetId } }); }
  setModelPreference(modelTargetId: string | null, reasoningEffort?: ReasoningEffort) { return request<void>({ operation: 'models.preference', body: { modelTargetId, reasoningEffort: reasoningEffort ?? null } }); }

  getPromptSettings() { return request<RuntimePromptSettings>({ operation: 'prompts.get' }); }
  getDefaultPromptSettings() { return request<RuntimePromptSettings>({ operation: 'prompts.defaults' }); }
  savePromptSettings(settings: Pick<RuntimePromptSettings, 'revision' | 'blocks'>) { return request<RuntimePromptSettings>({ operation: 'prompts.save', body: settings }); }
  getWebSearchSettings() { return request<RuntimeWebSearchSettings>({ operation: 'search.get' }); }
  saveWebSearchSettings(settings: { enabled: boolean; provider: RuntimeWebSearchSettings['provider']; mode: RuntimeWebSearchSettings['mode']; baseUrl?: string; apiKey?: string }) { return request<RuntimeWebSearchSettings>({ operation: 'search.save', body: settings }); }
  clearWebSearchCredential() { return request<RuntimeWebSearchSettings>({ operation: 'search.clear' }); }
  testWebSearch() { return request<RuntimeWebSearchResult>({ operation: 'search.test' }); }

  async listMcpServers() { return (await request<{ servers: RuntimeMcpServer[] }>({ operation: 'mcp.list' })).servers; }
  async listMcpCatalog() { return (await request<{ servers: RuntimeMcpCatalogServer[] }>({ operation: 'mcp.catalog' })).servers; }
  saveMcpServer(name: string, config: RuntimeMcpServerConfig) { return request<RuntimeMcpServer>({ operation: 'mcp.save', params: { name }, body: config }); }
  deleteMcpServer(name: string) { return request<void>({ operation: 'mcp.delete', params: { name } }); }
  testMcpServer(name: string, config: RuntimeMcpServerConfig) { return request<{ tools: RuntimeMcpServer['tools'] }>({ operation: 'mcp.test', body: { name, config } }); }
  async listSkills(context: RuntimeSkillContext = {}) { 
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(context)) if (value !== undefined) values[key] = String(value);
    return (await request<RuntimeSkillCatalog>({ operation: 'skills.list', query: values })).data;
 }
 async getSkillDetail(skillId: string): Promise<SkillDetail> { return await request({ operation: 'skills.detail', params: { skillId } }); }

  searchWorkspaceFiles(projectId: string, q = '', limit = 20) { return request<RuntimeWorkspaceFileSearchResult>({ operation: 'workspace.search', params: { projectId }, query: { q, limit: String(limit) } }); }
  listWorkspaceDirectory(projectId: string, path = '.', maxEntries = 200) { return request<RuntimeWorkspaceTree>({ operation: 'workspace.tree', params: { projectId }, query: { path, maxEntries: String(maxEntries) } }); }
  previewWorkspaceFile(projectId: string, path: string) { return request<WorkspaceFilePreview>({ operation: 'workspace.preview', params: { projectId }, query: { path } }); }
  async uploadFile(sessionId: string, file: File, filename = file.name) {
    if (file.size > 25 * 1024 * 1024) throw new Error('File exceeds the 25 MiB limit.');
    return request<RuntimeStoredFile>({ operation: 'files.upload', params: { sessionId }, body: { filename, mediaType: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) } });
  }
  async getFileContent(sessionId: string, fileId: string) {
    const result = await request<{ bytes: Uint8Array; mediaType: string }>({ operation: 'files.content', params: { sessionId, fileId } });
    return new Blob([new Uint8Array(result.bytes)], { type: result.mediaType });
  }
  streamResponse(sessionId: string, model: string, content: ResponseInputPartDto[], reasoningEffort: ReasoningEffort | undefined, permissionMode: PermissionMode, onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal) {
    const input = content.map((part) => part.type === 'input_file' ? { type: 'input_file' as const, file_id: part.file_id } : part);
    return stream({ operation: 'responses.create', params: { sessionId }, body: { model, ...(reasoningEffort ? { reasoningEffort } : {}), permissionMode, input: [{ type: 'message', role: 'user', content: input }] } satisfies CreateResponseRequest }, onEvent, signal);
  }
  streamPermission(sessionId: string, responseId: string, batchId: string, decisions: PermissionResolutionDto[], onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal) {
    const body: ResolvePermissionsRequest = {
      batchId,
      decisions: decisions.map(({ permission_id, decision, reason }) => ({
        permission_id,
        decision,
        ...(decision === 'deny' && reason !== undefined ? { reason } : {}),
      })),
    };
    return stream({ operation: 'responses.permissions', params: { sessionId, responseId }, body }, onEvent, signal);
  }
  cancelResponse(sessionId: string, responseId: string) { return request<AgentResponseDto>({ operation: 'responses.cancel', params: { sessionId, responseId } }); }
}

export const localClient: AgentRuntimeClient = new LocalRuntimeClient();
