// Business operation names; payload validation and ownership checks run in the Agent.
export const agentOperations = [
  'runtime.info',
  'projects.list',
  'projects.create',
  'projects.delete',
  'workspace.search',
  'workspace.tree',
  'workspace.preview',
  'sessions.list',
  'sessions.create',
  'sessions.rename',
  'sessions.delete',
  'sessions.bind',
  'sessions.context',
  'sessions.compact',
  'responses.create',
  'responses.permissions',
  'responses.cancel',
  'files.upload',
  'files.content',
  'models.list',
  'models.update',
  'models.delete',
  'models.preference',
  'accounts.list',
  'accounts.create',
  'accounts.update',
  'accounts.delete',
  'accounts.credential.replace',
  'accounts.credential.clear',
  'models.create',
  'prompts.get',
  'prompts.defaults',
  'prompts.save',
  'search.get',
  'search.save',
  'search.clear',
  'search.test',
  'mcp.list',
  'mcp.catalog',
  'mcp.save',
  'mcp.delete',
  'mcp.test',
  'skills.list',
  'skills.detail',
] as const;

export type AgentOperation = (typeof agentOperations)[number];
export type WorkspaceFilePreview =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaType: string; bytes: Uint8Array }
  | { kind: 'missing' | 'unsupported' | 'too-large' };
export interface AgentCommand {
  operation: AgentOperation;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}
export interface AgentFailure { code: string; message: string; status?: number; details?: unknown }
export type AgentResult<T = unknown> = { ok: true; value: T } | { ok: false; error: AgentFailure };
export interface AgentEventBatch { subscriptionId: string; events: unknown[] }
export interface AgentRuntimeInfo { mode: 'development' | 'release'; ownerId: string; modelConfigurationEnabled: boolean }
export interface DesktopSettings { storageDirectory: string }
export interface DesktopApi {
  ready(): Promise<AgentRuntimeInfo>;
  request(command: AgentCommand): Promise<AgentResult>;
  stream(subscriptionId: string, command: AgentCommand): Promise<AgentResult>;
  onEvents(listener: (batch: AgentEventBatch) => void): () => void;
  detach(subscriptionId: string): void;
  restart(): Promise<void>;
  writeClipboardText(text: string): Promise<void>;
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: DesktopSettings): Promise<void>;
  pickDirectory(): Promise<string | null>;
  openDirectory(kind: 'storage' | 'logs' | 'skills' | 'config'): Promise<void>;
  notify(kind: 'completed' | 'permission_requested', title: string, detail: string): Promise<void>;
}

export interface AgentBootOptions { homeDirectory: string; mode: 'development' | 'release' }
export type AgentWorkerRequest =
  | { type: 'initialize'; options: AgentBootOptions }
  | { type: 'request'; id: string; command: AgentCommand; stream: boolean }
  | { type: 'detach'; id: string }
  | { type: 'shutdown' };
export type AgentWorkerResponse =
  | { type: 'ready' }
  | { type: 'initialized'; result: AgentResult<AgentRuntimeInfo> }
  | { type: 'result'; id: string; result: AgentResult }
  | { type: 'events'; id: string; events: unknown[] }
  | { type: 'stopped' };
