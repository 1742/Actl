import { tr } from '../../../i18n';
import { ResponseStreamParser } from '../../composables/useResponseStream';
import { parseResponseStreamEvent } from '../../composables/useResponseReducer';
import { useRuntimeStore } from '../../../stores/runtime';
import type { AIFileContent } from '../../types/aiResponse';
import type {
  AgentInputContent,
  AgentPermissionMode,
  AgentResponse,
  RuntimeControlError,
  RuntimeModel,
  RuntimeModelConfig,
  RuntimeModelCatalog,
  RuntimeProviderAccount,
  RuntimeReasoningEffort,
  CreateRuntimeProviderAccount,
  PermissionDecision,
  AgentProject,
  AgentSession,
  RuntimeSkill,
  RuntimeSkillCatalog,
  RuntimeSkillContext,
  RuntimeStoredFile,
  RuntimeStreamEvent,
  RuntimeWorkspaceFileSearchResult,
  RuntimeWorkspaceTree,
  RuntimeWebSearchResult,
  RuntimeWebSearchSettings,
  RuntimePromptSettings,
  RuntimeMcpServer,
  RuntimeMcpServerConfig,
  RuntimeMcpCatalogServer,
  SessionContext,
} from '../../types';
import type { AgentRuntimeClient } from '../runtimeClient';

type RequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class RuntimeRequestError extends Error {
  readonly code: string;
  readonly details?: RuntimeControlError['error']['details'];
  readonly status?: number;

  constructor(error: RuntimeControlError['error'], status?: number) {
    super(error.message || tr('ui.agentRuntimeRequestFailed'));
    this.name = 'RuntimeRequestError';
    this.code = error.code;
    this.details = error.details;
    this.status = status;
  }
}

//#region helper

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function fetchAgentHealth(baseUrl: string): Promise<boolean> {
  const response = await fetch(joinUrl(baseUrl, '/health'), {
    method: 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) return false;
  const data: unknown = await response.json();
  return typeof data === 'object' && data !== null && 'ok' in data && data.ok === true;
}

function agentHeaders(headers: Record<string, string> = {}) {
  const runtime = useRuntimeStore();
  return {
    ...headers,
    ...(runtime.agentToken ? { 'X-Actl-Agent-Token': runtime.agentToken } : {}),
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: T | RuntimeControlError | undefined;
  try {
    data = text ? (JSON.parse(text) as T | RuntimeControlError) : undefined;
  } catch {
    if (!response.ok)
      throw new Error(tr('dynamic.runtimeRequestFailed', { status: response.status }));
    throw new Error(tr('ui.agentRuntimeReturnedInvalidJson'));
  }
  if (!response.ok) {
    const error = (data as RuntimeControlError | undefined)?.error;
    if (error) throw new RuntimeRequestError(error, response.status);
    throw new Error(tr('dynamic.runtimeRequestFailed', { status: response.status }));
  }
  return data as T;
}

async function requestRuntime<T>(
  baseUrl: string,
  path: string,
  method: RequestMethod,
  body?: object,
) {
  const response = await fetch(joinUrl(baseUrl, path), {
    method,
    headers: agentHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  return parseResponse<T>(response);
}

//#endregion

//#region project

export const fetchRuntimeProjects = (baseUrl: string) =>
  requestRuntime<AgentProject[]>(baseUrl, '/projects', 'GET');

export const createRuntimeProject = (baseUrl: string, cwd: string) =>
  requestRuntime<AgentProject>(baseUrl, '/projects', 'POST', { cwd });

export const deleteRuntimeProject = (baseUrl: string, projectId: string) =>
  requestRuntime<void>(baseUrl, `/projects/${encodeURIComponent(projectId)}`, 'DELETE');

//#endregion

//#region session

export const fetchRuntimeSessions = (baseUrl: string) =>
  requestRuntime<AgentSession[]>(baseUrl, '/sessions', 'GET');

export const createRuntimeSession = (baseUrl: string, projectId?: string) =>
  requestRuntime<AgentSession>(baseUrl, '/sessions', 'POST', projectId ? { projectId } : {});

export const renameRuntimeSession = (baseUrl: string, sessionId: string, title: string | null) =>
  requestRuntime<AgentSession>(baseUrl, `/sessions/${encodeURIComponent(sessionId)}`, 'PATCH', {
    title,
  });

export const bindRuntimeSessionToProject = (
  baseUrl: string,
  sessionId: string,
  projectId: string,
) =>
  requestRuntime<AgentSession>(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/project`,
    'PUT',
    { projectId },
  );

export const fetchRuntimeContext = (baseUrl: string, sessionId: string) =>
  requestRuntime<SessionContext>(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/context`,
    'GET',
  );

export const deleteRuntimeSession = (baseUrl: string, sessionId: string) =>
  requestRuntime<void>(baseUrl, `/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');

export const compactRuntimeSession = (
  baseUrl: string,
  sessionId: string,
  model: string,
  reasoningEffort?: RuntimeReasoningEffort,
) =>
  requestRuntime<{ compressed: boolean; summarized_run_count: number }>(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/compact`,
    'POST',
    {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  );

//#endregion

//#region model

export const fetchRuntimeModels = (baseUrl: string, sessionId?: string) =>
  requestRuntime<RuntimeModelCatalog>(
    baseUrl,
    `/models${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    'GET',
  );

export const fetchRuntimeProviderAccounts = async (baseUrl: string) =>
  (await requestRuntime<{ data: RuntimeProviderAccount[] }>(baseUrl, '/provider-accounts', 'GET'))
    .data;

export const createRuntimeProviderAccount = (
  baseUrl: string,
  config: CreateRuntimeProviderAccount,
) => requestRuntime<RuntimeProviderAccount>(baseUrl, '/provider-accounts', 'POST', config);

export const updateRuntimeProviderAccount = (
  baseUrl: string,
  accountId: string,
  config: Pick<CreateRuntimeProviderAccount, 'displayName' | 'baseURL'>,
) =>
  requestRuntime<RuntimeProviderAccount>(
    baseUrl,
    `/provider-accounts/${encodeURIComponent(accountId)}`,
    'PATCH',
    config,
  );

export const replaceRuntimeProviderCredential = (
  baseUrl: string,
  accountId: string,
  apiKey: string,
) =>
  requestRuntime<void>(
    baseUrl,
    `/provider-accounts/${encodeURIComponent(accountId)}/credential`,
    'PUT',
    { apiKey },
  );

export const deleteRuntimeProviderAccount = (baseUrl: string, accountId: string) =>
  requestRuntime<void>(baseUrl, `/provider-accounts/${encodeURIComponent(accountId)}`, 'DELETE');

export const clearRuntimeProviderCredential = (baseUrl: string, accountId: string) =>
  requestRuntime<void>(
    baseUrl,
    `/provider-accounts/${encodeURIComponent(accountId)}/credential`,
    'DELETE',
  );

export const createRuntimeModel = (baseUrl: string, accountId: string, model: RuntimeModelConfig) =>
  requestRuntime<RuntimeModel>(
    baseUrl,
    `/provider-accounts/${encodeURIComponent(accountId)}/models`,
    'POST',
    model,
  );

export const updateRuntimeModel = (
  baseUrl: string,
  modelTargetId: string,
  model: RuntimeModelConfig,
) =>
  requestRuntime<RuntimeModel>(
    baseUrl,
    `/models/${encodeURIComponent(modelTargetId)}`,
    'PATCH',
    model,
  );

export const deleteRuntimeModel = (baseUrl: string, modelTargetId: string) =>
  requestRuntime<void>(baseUrl, `/models/${encodeURIComponent(modelTargetId)}`, 'DELETE');

export const setRuntimeModelPreference = (
  baseUrl: string,
  modelTargetId: string | null,
  reasoningEffort?: RuntimeReasoningEffort,
) =>
  requestRuntime<void>(baseUrl, '/models/preference', 'PUT', {
    modelTargetId,
    reasoningEffort: reasoningEffort ?? null,
  });

//#endregion

//#region web search

export const fetchRuntimePromptSettings = (baseUrl: string) =>
  requestRuntime<RuntimePromptSettings>(baseUrl, '/prompt-settings', 'GET');

export const fetchDefaultRuntimePromptSettings = (baseUrl: string) =>
  requestRuntime<RuntimePromptSettings>(baseUrl, '/prompt-settings/defaults', 'GET');

export const saveRuntimePromptSettings = (
  baseUrl: string,
  settings: Pick<RuntimePromptSettings, 'revision' | 'blocks'>,
) => requestRuntime<RuntimePromptSettings>(baseUrl, '/prompt-settings', 'PUT', settings);

export const fetchRuntimeWebSearchSettings = (baseUrl: string) =>
  requestRuntime<RuntimeWebSearchSettings>(baseUrl, '/web-search', 'GET');

export const saveRuntimeWebSearchSettings = (
  baseUrl: string,
  settings: {
    enabled: boolean;
    provider: RuntimeWebSearchSettings['provider'];
    mode: RuntimeWebSearchSettings['mode'];
    baseUrl?: string;
    apiKey?: string;
  },
) => requestRuntime<RuntimeWebSearchSettings>(baseUrl, '/web-search', 'PUT', settings);

export const clearRuntimeWebSearchCredential = (baseUrl: string) =>
  requestRuntime<RuntimeWebSearchSettings>(baseUrl, '/web-search/credential', 'DELETE');

export const testRuntimeWebSearch = (baseUrl: string) =>
  requestRuntime<RuntimeWebSearchResult>(baseUrl, '/web-search/test', 'POST');

//#endregion

//#region mcp

export const fetchRuntimeMcpServers = async (baseUrl: string) =>
  (await requestRuntime<{ servers: RuntimeMcpServer[] }>(baseUrl, '/mcp/servers', 'GET')).servers;

export const fetchRuntimeMcpCatalog = async (baseUrl: string) =>
  (await requestRuntime<{ servers: RuntimeMcpCatalogServer[] }>(baseUrl, '/mcp/catalog', 'GET'))
    .servers;

export const saveRuntimeMcpServer = (
  baseUrl: string,
  name: string,
  config: RuntimeMcpServerConfig,
) =>
  requestRuntime<RuntimeMcpServer>(
    baseUrl,
    `/mcp/servers/${encodeURIComponent(name)}`,
    'PUT',
    config,
  );

export const deleteRuntimeMcpServer = (baseUrl: string, name: string) =>
  requestRuntime<void>(baseUrl, `/mcp/servers/${encodeURIComponent(name)}`, 'DELETE');

export const testRuntimeMcpServer = (
  baseUrl: string,
  name: string,
  config: RuntimeMcpServerConfig,
) =>
  requestRuntime<{ tools: RuntimeMcpServer['tools'] }>(baseUrl, '/mcp/test', 'POST', {
    name,
    config,
  });

//#endregion

//#region skills

export const fetchRuntimeSkills = async (baseUrl: string, context: RuntimeSkillContext = {}) => {
  const query = new URLSearchParams();
  if (context.sessionId) query.set('sessionId', context.sessionId);
  else if (context.projectId) query.set('projectId', context.projectId);
  const suffix = query.size ? `?${query.toString()}` : '';
  const catalog = await requestRuntime<RuntimeSkillCatalog>(baseUrl, `/skills${suffix}`, 'GET');
  return catalog.data as RuntimeSkill[];
};

//#endregion

//#region workspace

export const searchRuntimeWorkspaceFiles = (
  baseUrl: string,
  projectId: string,
  query = '',
  limit = 20,
) => {
  const search = new URLSearchParams({ q: query, limit: String(limit) });
  return requestRuntime<RuntimeWorkspaceFileSearchResult>(
    baseUrl,
    `/projects/${encodeURIComponent(projectId)}/files/search?${search.toString()}`,
    'GET',
  );
};

export const listRuntimeWorkspaceDirectory = (
  baseUrl: string,
  projectId: string,
  path = '.',
  maxEntries = 200,
) => {
  const search = new URLSearchParams({ path, maxEntries: String(maxEntries) });
  return requestRuntime<RuntimeWorkspaceTree>(
    baseUrl,
    `/projects/${encodeURIComponent(projectId)}/files/tree?${search.toString()}`,
    'GET',
  );
};

//#endregion

//#region file

export async function uploadRuntimeFile(
  baseUrl: string,
  sessionId: string,
  file: File,
  filename = file.name,
) {
  const formData = new FormData();
  formData.append('file', file, filename);
  const response = await fetch(
    joinUrl(baseUrl, `/sessions/${encodeURIComponent(sessionId)}/files`),
    {
      method: 'POST',
      headers: agentHeaders(),
      body: formData,
    },
  );
  return parseResponse<RuntimeStoredFile>(response);
}
export async function fetchRuntimeFileContent(baseUrl: string, sessionId: string, fileId: string) {
  const response = await fetch(
    joinUrl(
      baseUrl,
      `/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/content`,
    ),
    { headers: agentHeaders() },
  );
  if (!response.ok) await parseResponse<never>(response);
  return response.blob();
}
export const cancelRuntimeResponse = (baseUrl: string, sessionId: string, responseId: string) =>
  requestRuntime<AgentResponse>(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/responses/${encodeURIComponent(responseId)}/cancel`,
    'POST',
  );

//#endregion

//#region responses

export function streamRuntimeResponse(
  baseUrl: string,
  sessionId: string,
  model: string,
  content: AgentInputContent[],
  reasoningEffort: RuntimeReasoningEffort | undefined,
  permissionMode: AgentPermissionMode,
  onEvent: (event: RuntimeStreamEvent) => void,
  signal?: AbortSignal,
) {
  const requestContent = content.map((part) => {
    if (part.type !== 'input_file') return part;
    return { type: 'input_file', file_id: part.file_id } as AIFileContent;
  });
  return streamRequest(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/responses`,
    {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      permissionMode,
      input: [{ type: 'message', role: 'user', content: requestContent }],
      stream: true,
    },
    onEvent,
    signal,
  );
}

export function streamRuntimePermission(
  baseUrl: string,
  sessionId: string,
  responseId: string,
  batchId: string,
  decisions: PermissionDecision[],
  onEvent: (event: RuntimeStreamEvent) => void,
  signal?: AbortSignal,
) {
  return streamRequest(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/responses/${encodeURIComponent(responseId)}/permissions`,
    { batchId, decisions },
    onEvent,
    signal,
  );
}

async function streamRequest(
  baseUrl: string,
  path: string,
  body: object,
  onEvent: (event: RuntimeStreamEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(joinUrl(baseUrl, path), {
    method: 'POST',
    headers: agentHeaders({ Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) return parseResponse<never>(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new ResponseStreamParser();
  let terminal: RuntimeStreamEvent | undefined;
  let reachedBoundary = false;

  const consume = (frames: ReturnType<ResponseStreamParser['push']>) => {
    for (const frame of frames) {
      const data = parseResponseStreamEvent(frame);
      if (!data) {
        if (frame.done || frame.data === '[DONE]') continue;
        throw new Error(tr('ui.agentRuntimeReturnedAnInvalidStream'));
      }
      if (frame.event === 'error') {
        const error = (data as unknown as RuntimeControlError).error;
        if (error) throw new RuntimeRequestError(error);
        throw new Error(tr('ui.agentRuntimeStreamRequestFailed'));
      }
      terminal = data as RuntimeStreamEvent;
      onEvent(terminal);
      reachedBoundary =
        terminal.type === 'response.completed' ||
        terminal.type === 'response.failed' ||
        terminal.type === 'response.incomplete' ||
        terminal.type === 'response.cancelled' ||
        terminal.type === 'agent.permissions.requested';
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(parser.push(decoder.decode(value, { stream: true })));
  }
  consume(parser.flush());
  if (!reachedBoundary) throw new Error(tr('ui.agentRuntimeStreamEndedUnexpectedly'));
  return terminal;
}

//#endregion

export class LocalRuntimeClient implements AgentRuntimeClient {
  readonly kind = 'local' as const;
  readonly capabilities = {
    modelConfiguration: true,
    skills: true,
    workspace: true,
    uploadFile: true,
    permissions: true,
    sessionProjectBinding: true,
    localProjectPaths: true,
  } as const;

  getBaseUrl() {
    return useRuntimeStore().agentUrl;
  }

  //#region project

  listProjects() {
    return fetchRuntimeProjects(this.getBaseUrl());
  }

  createProject(value: string) {
    return createRuntimeProject(this.getBaseUrl(), value);
  }

  deleteProject(projectId: string) {
    return deleteRuntimeProject(this.getBaseUrl(), projectId);
  }

  //#endregion

  //#region session

  listSessions() {
    return fetchRuntimeSessions(this.getBaseUrl());
  }

  createSession(projectId?: string) {
    return createRuntimeSession(this.getBaseUrl(), projectId);
  }

  renameSession(sessionId: string, title: string | null) {
    return renameRuntimeSession(this.getBaseUrl(), sessionId, title);
  }

  bindSessionToProject(sessionId: string, projectId: string) {
    return bindRuntimeSessionToProject(this.getBaseUrl(), sessionId, projectId);
  }

  deleteSession(sessionId: string) {
    return deleteRuntimeSession(this.getBaseUrl(), sessionId);
  }

  getContext(sessionId: string) {
    return fetchRuntimeContext(this.getBaseUrl(), sessionId);
  }

  compactSession(sessionId: string, model: string, reasoningEffort?: RuntimeReasoningEffort) {
    return compactRuntimeSession(this.getBaseUrl(), sessionId, model, reasoningEffort);
  }

  //#endregion

  //#region model

  listModels(sessionId?: string) {
    return fetchRuntimeModels(this.getBaseUrl(), sessionId);
  }

  listProviderAccounts() {
    return fetchRuntimeProviderAccounts(this.getBaseUrl());
  }

  createProviderAccount(config: CreateRuntimeProviderAccount) {
    return createRuntimeProviderAccount(this.getBaseUrl(), config);
  }

  updateProviderAccount(
    accountId: string,
    config: Pick<CreateRuntimeProviderAccount, 'displayName' | 'baseURL'>,
  ) {
    return updateRuntimeProviderAccount(this.getBaseUrl(), accountId, config);
  }

  replaceProviderCredential(accountId: string, apiKey: string) {
    return replaceRuntimeProviderCredential(this.getBaseUrl(), accountId, apiKey);
  }

  deleteProviderAccount(accountId: string) {
    return deleteRuntimeProviderAccount(this.getBaseUrl(), accountId);
  }

  clearProviderCredential(accountId: string) {
    return clearRuntimeProviderCredential(this.getBaseUrl(), accountId);
  }

  createModel(accountId: string, model: RuntimeModelConfig) {
    return createRuntimeModel(this.getBaseUrl(), accountId, model);
  }

  updateModel(modelTargetId: string, model: RuntimeModelConfig) {
    return updateRuntimeModel(this.getBaseUrl(), modelTargetId, model);
  }

  deleteModel(modelTargetId: string) {
    return deleteRuntimeModel(this.getBaseUrl(), modelTargetId);
  }

  setModelPreference(modelTargetId: string | null, reasoningEffort?: RuntimeReasoningEffort) {
    return setRuntimeModelPreference(this.getBaseUrl(), modelTargetId, reasoningEffort);
  }

  //#endregion

  //#region web search

  getPromptSettings() {
    return fetchRuntimePromptSettings(this.getBaseUrl());
  }

  getDefaultPromptSettings() {
    return fetchDefaultRuntimePromptSettings(this.getBaseUrl());
  }

  savePromptSettings(settings: Pick<RuntimePromptSettings, 'revision' | 'blocks'>) {
    return saveRuntimePromptSettings(this.getBaseUrl(), settings);
  }

  getWebSearchSettings() {
    return fetchRuntimeWebSearchSettings(this.getBaseUrl());
  }

  saveWebSearchSettings(settings: {
    enabled: boolean;
    provider: RuntimeWebSearchSettings['provider'];
    mode: RuntimeWebSearchSettings['mode'];
    baseUrl?: string;
    apiKey?: string;
  }) {
    return saveRuntimeWebSearchSettings(this.getBaseUrl(), settings);
  }

  clearWebSearchCredential() {
    return clearRuntimeWebSearchCredential(this.getBaseUrl());
  }

  testWebSearch() {
    return testRuntimeWebSearch(this.getBaseUrl());
  }

  //#endregion

  //#region mcp

  listMcpServers() {
    return fetchRuntimeMcpServers(this.getBaseUrl());
  }

  listMcpCatalog() {
    return fetchRuntimeMcpCatalog(this.getBaseUrl());
  }

  saveMcpServer(name: string, config: RuntimeMcpServerConfig) {
    return saveRuntimeMcpServer(this.getBaseUrl(), name, config);
  }

  deleteMcpServer(name: string) {
    return deleteRuntimeMcpServer(this.getBaseUrl(), name);
  }

  testMcpServer(name: string, config: RuntimeMcpServerConfig) {
    return testRuntimeMcpServer(this.getBaseUrl(), name, config);
  }

  //#endregion

  //#region skills

  listSkills(context?: RuntimeSkillContext) {
    return fetchRuntimeSkills(this.getBaseUrl(), context);
  }

  //#endregion

  //#region workspace

  searchWorkspaceFiles(projectId: string, query?: string, limit?: number) {
    return searchRuntimeWorkspaceFiles(this.getBaseUrl(), projectId, query, limit);
  }

  listWorkspaceDirectory(projectId: string, path = '.', maxEntries = 200) {
    return listRuntimeWorkspaceDirectory(this.getBaseUrl(), projectId, path, maxEntries);
  }

  //#endregion

  //#region file

  uploadFile(sessionId: string, file: File, filename?: string) {
    return uploadRuntimeFile(this.getBaseUrl(), sessionId, file, filename);
  }

  getFileContent(sessionId: string, fileId: string) {
    return fetchRuntimeFileContent(this.getBaseUrl(), sessionId, fileId);
  }

  //#endregion

  //#region response

  streamResponse(
    sessionId: string,
    model: string,
    content: AgentInputContent[],
    reasoningEffort: RuntimeReasoningEffort | undefined,
    permissionMode: AgentPermissionMode,
    onEvent: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ) {
    return streamRuntimeResponse(
      this.getBaseUrl(),
      sessionId,
      model,
      content,
      reasoningEffort,
      permissionMode,
      onEvent,
      signal,
    );
  }

  cancelResponse(sessionId: string, responseId: string) {
    return cancelRuntimeResponse(this.getBaseUrl(), sessionId, responseId);
  }

  streamPermission(
    sessionId: string,
    responseId: string,
    batchId: string,
    decisions: PermissionDecision[],
    onEvent: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ) {
    return streamRuntimePermission(
      this.getBaseUrl(),
      sessionId,
      responseId,
      batchId,
      decisions,
      onEvent,
      signal,
    );
  }

  //#endregion
}

export const localClient: AgentRuntimeClient = new LocalRuntimeClient();
