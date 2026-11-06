// Names are shared; payload schemas and ownership checks run in the Agent process.
export const agentRoutes = [
  ['GET', '/runtime', 'runtime.info'],
  ['GET', '/projects', 'projects.list'], ['POST', '/projects', 'projects.create'],
  ['DELETE', '/projects/:projectId', 'projects.delete'],
  ['GET', '/projects/:projectId/files/search', 'workspace.search'],
  ['GET', '/projects/:projectId/files/tree', 'workspace.tree'],
  ['GET', '/sessions', 'sessions.list'], ['POST', '/sessions', 'sessions.create'],
  ['PATCH', '/sessions/:sessionId', 'sessions.rename'], ['DELETE', '/sessions/:sessionId', 'sessions.delete'],
  ['PUT', '/sessions/:sessionId/project', 'sessions.bind'],
  ['GET', '/sessions/:sessionId/context', 'sessions.context'],
  ['POST', '/sessions/:sessionId/compact', 'sessions.compact'],
  ['POST', '/sessions/:sessionId/responses', 'responses.create'],
  ['POST', '/sessions/:sessionId/responses/:responseId/permissions', 'responses.permissions'],
  ['POST', '/sessions/:sessionId/responses/:responseId/cancel', 'responses.cancel'],
  ['POST', '/sessions/:sessionId/files', 'files.upload'],
  ['GET', '/sessions/:sessionId/files/:fileId/content', 'files.content'],
  ['GET', '/models', 'models.list'], ['PATCH', '/models/:modelTargetId', 'models.update'],
  ['DELETE', '/models/:modelTargetId', 'models.delete'], ['PUT', '/models/preference', 'models.preference'],
  ['GET', '/provider-accounts', 'accounts.list'], ['POST', '/provider-accounts', 'accounts.create'],
  ['PATCH', '/provider-accounts/:accountId', 'accounts.update'], ['DELETE', '/provider-accounts/:accountId', 'accounts.delete'],
  ['PUT', '/provider-accounts/:accountId/credential', 'accounts.credential.replace'],
  ['DELETE', '/provider-accounts/:accountId/credential', 'accounts.credential.clear'],
  ['POST', '/provider-accounts/:accountId/models', 'models.create'],
  ['GET', '/prompt-settings', 'prompts.get'], ['GET', '/prompt-settings/defaults', 'prompts.defaults'],
  ['PUT', '/prompt-settings', 'prompts.save'],
  ['GET', '/web-search', 'search.get'], ['PUT', '/web-search', 'search.save'],
  ['DELETE', '/web-search/credential', 'search.clear'], ['POST', '/web-search/test', 'search.test'],
  ['GET', '/mcp/servers', 'mcp.list'], ['GET', '/mcp/catalog', 'mcp.catalog'],
  ['PUT', '/mcp/servers/:name', 'mcp.save'], ['DELETE', '/mcp/servers/:name', 'mcp.delete'],
  ['POST', '/mcp/test', 'mcp.test'],
  ['GET', '/skills', 'skills.list'], ['GET', '/skills/:skillId', 'skills.detail'],
] as const;

export type AgentOperation = (typeof agentRoutes)[number][2];
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
  getSettings(): Promise<DesktopSettings>;
  saveSettings(settings: DesktopSettings): Promise<void>;
  pickDirectory(): Promise<string | null>;
  openDirectory(kind: 'storage' | 'logs' | 'skills' | 'config'): Promise<void>;
  notify(kind: 'completed' | 'permission_requested', title: string, detail: string): Promise<void>;
}

// Temporary adapter for existing frontend use cases; this never makes a network request.
export function commandForRoute(method: string, route: string, body?: unknown): AgentCommand {
  const url = new URL(route, 'actl://runtime');
  const parts = url.pathname.split('/').filter(Boolean);
  for (const [verb, template, operation] of agentRoutes) {
    const expected = template.split('/').filter(Boolean);
    if (verb !== method || parts.length !== expected.length) continue;
    const params: Record<string, string> = {};
    if (!expected.every((part, index) => {
      if (part.startsWith(':')) { params[part.slice(1)] = decodeURIComponent(parts[index]!); return true; }
      return part === parts[index];
    })) continue;
    return { operation, params, query: Object.fromEntries(url.searchParams), ...(body === undefined ? {} : { body }) };
  }
  throw new Error(`Unsupported Agent operation: ${method} ${url.pathname}`);
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
