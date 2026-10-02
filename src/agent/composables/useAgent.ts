import { tr } from '../../i18n';
import { isTauri } from '@tauri-apps/api/core';
import { bridge } from '../../services/bridge';
import { reduceResponseEvent } from './useResponseReducer';
import { releaseSelections } from './useFileBridge';
import type { AIFileContent, AIResponseContext } from '../types/aiResponse';
import { normalizeResponseContext } from '../utils/aiResponse';
import { getAgentRuntimeContext, RuntimeRequestError } from '../services/runtimeClient';
import { useAgentStore } from '../stores/agent';
import type {
  AgentComposerAttachment,
  AgentInputContent,
  AgentPermissionMode,
  ActionResult,
  AgentPermissionEvent,
  AgentResponse,
  PermissionDecision,
  PermissionRequestItem,
  RuntimeModelConfig,
  RuntimeStreamEvent,
  CreateRuntimeProviderAccount,
  RuntimeSkill,
  RuntimeSkillContext,
  RuntimeReasoningEffort,
  AgentRuntimeKind,
  RuntimeProject,
  RuntimeSession,
  AgentProject,
  AgentSession,
} from '../types';
import { agentResponsesToContexts, titleFromInput } from '../utils';

const activeStreamControllers = new Map<string, AbortController>();
const historyRequestVersions = new Map<string, number>();
let skillsRequestVersion = 0;
let modelsRequestVersion = 0;

function notifyAgentEvent(
  sessionId: string,
  kind: 'completed' | 'permission_requested',
  detail: string,
) {
  if (!isTauri()) return;
  const session = useAgentStore().sessions.find((item) => item.id === sessionId);
  void bridge
    .notifyAgentEvent(kind, session?.title || tr('ui.currentConversation'), detail)
    .catch((error) => console.warn('Unable to show Agent notification:', error));
}

type PersistedAgentView =
  { type: 'session'; id: string } | { type: 'project'; id: string } | { type: 'standalone' };

function persistedAgentViewStorageKey() {
  return 'ai-agent:last-view:local';
}

function readPersistedAgentView(): PersistedAgentView | undefined {
  try {
    const stored = localStorage.getItem(persistedAgentViewStorageKey());
    if (stored) {
      const view = JSON.parse(stored) as PersistedAgentView;
      if (view.type === 'session' && view.id) return view;
      if (view.type === 'project' && view.id) return view;
      if (view.type === 'standalone') return view;
    }

    // Migrate the session-only preference saved by the previous implementation.
    const legacySessionId = localStorage.getItem('ai-agent:last-selected-session:anonymous');
    return legacySessionId ? { type: 'session', id: legacySessionId } : undefined;
  } catch {
    return undefined;
  }
}

function savePersistedAgentView(view: PersistedAgentView) {
  localStorage.setItem(persistedAgentViewStorageKey(), JSON.stringify(view));
}

function latestProjectFromSessionActivity() {
  const store = useAgentStore();
  const latestProjectSession = [...store.sessions]
    .filter((session) => session.projectId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  return latestProjectSession?.projectId
    ? store.projects.find((project) => project.id === latestProjectSession.projectId)
    : undefined;
}

export function runtimeResourceKey(kind: AgentRuntimeKind, id: string) {
  return `${kind}:${id}`;
}

function decorateProject(kind: AgentRuntimeKind, project: AgentProject): RuntimeProject {
  return {
    ...project,
    id: runtimeResourceKey(kind, project.id),
    runtimeId: project.id,
    runtimeKind: kind,
  };
}

function decorateSession(kind: AgentRuntimeKind, session: AgentSession): RuntimeSession {
  return {
    ...session,
    id: runtimeResourceKey(kind, session.id),
    runtimeId: session.id,
    runtimeKind: kind,
    runtimeProjectId: session.projectId,
    projectId: session.projectId ? runtimeResourceKey(kind, session.projectId) : null,
  };
}

function activateRuntime(kind: AgentRuntimeKind) {
  const store = useAgentStore();
  const context = getAgentRuntimeContext(kind);
  store.configureRuntime(kind, context.client.capabilities);
  return context;
}

function sessionContext(sessionId: string) {
  const store = useAgentStore();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error(tr('ui.conversationDoesNotExistOrHas'));
  return { session, ...getAgentRuntimeContext(session.runtimeKind) };
}

function projectContext(projectId: string) {
  const store = useAgentStore();
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(tr('ui.projectDoesNotExistOrHas'));
  return { project, ...getAgentRuntimeContext(project.runtimeKind) };
}

function currentSkillsContext() {
  const store = useAgentStore();
  if (store.selectedSessionId) {
    return {
      key: `session:${store.selectedSessionId}`,
      query: { sessionId: store.selectedSessionId } satisfies RuntimeSkillContext,
    };
  }
  if (store.draftProjectId) {
    return {
      key: `project:${store.draftProjectId}`,
      query: { projectId: store.draftProjectId } satisfies RuntimeSkillContext,
    };
  }
  return { key: `user:${store.runtimeKind}`, query: {} satisfies RuntimeSkillContext };
}

function errorResult(error: unknown): ActionResult {
  return {
    status: 'error',
    message: error instanceof Error ? error.message : String(error || tr('ui.operationFailed')),
  };
}

function modelMutationBlocked() {
  const store = useAgentStore();
  if (store.hasActiveResponse) {
    return { status: 'error' as const, message: tr('ui.agentActivityBlocksModelConfiguration') };
  }
  return undefined;
}

function syncStateFromResponse(sessionId: string, response?: { id?: string; status: string }) {
  const store = useAgentStore();
  if (response?.id) store.setActiveResponseId(sessionId, response.id);
  store.setStatus(
    sessionId,
    response?.status === 'in_progress'
      ? 'running'
      : response?.status === 'waiting_permission'
        ? 'waiting_permission'
        : 'idle',
  );
}

function sessionActivityBlocked(sessionId: string, action: string): ActionResult | undefined {
  const store = useAgentStore();
  return store.sessionIsActive(sessionId)
    ? {
        status: 'error',
        message: tr('dynamic.beforeActionStopSession', {
          state:
            store.runtimeBySessionId[sessionId]?.status === 'waiting_permission'
              ? tr('ui.awaitingPermission')
              : tr('ui.runningWord'),
          action,
        }),
      }
    : undefined;
}

function projectActivityBlocked(projectId: string, action: string): ActionResult | undefined {
  const store = useAgentStore();
  const ownerId = store.projectActivityOwner(projectId);
  if (!ownerId) return undefined;
  const owner = store.sessions.find((item) => item.id === ownerId);
  return {
    status: 'error',
    message: tr('dynamic.beforeActionStopProject', {
      title: owner?.title || tr('ui.newConversation'),
      action,
    }),
  };
}

export async function initAgentSession(kind: AgentRuntimeKind): Promise<ActionResult> {
  const store = useAgentStore();
  const { client } = getAgentRuntimeContext(kind);
  store.setRuntimeAvailability(kind, 'checking');
  try {
    const [projects, sessions] = await Promise.all([client.listProjects(), client.listSessions()]);
    store.setRuntimeProjects(
      kind,
      projects.map((item) => decorateProject(kind, item)),
    );
    store.setRuntimeSessions(
      kind,
      sessions.map((item) => decorateSession(kind, item)),
    );
    store.setRuntimeAvailability(kind, 'available');
    store.initialized = true;
    return { status: 'success' };
  } catch (error) {
    const result = errorResult(error);
    store.setRuntimeAvailability(kind, 'unavailable', result.message);
    return result;
  }
}

/** Restore the previous conversation, or open a draft in the most recently updated project. */
export async function restoreInitialAgentView(): Promise<ActionResult> {
  const store = useAgentStore();
  if (store.selectedSessionId || store.draftProjectId) return { status: 'success' };

  const persistedView = readPersistedAgentView();
  if (
    persistedView?.type === 'session' &&
    store.sessions.some((session) => session.id === persistedView.id)
  ) {
    return selectAgentSession(persistedView.id);
  }
  if (
    persistedView?.type === 'project' &&
    store.projects.some((project) => project.id === persistedView.id)
  ) {
    startNewAgentDraft(persistedView.id);
    return { status: 'success' };
  }
  if (persistedView?.type === 'standalone') {
    startNewAgentDraft();
    return { status: 'success' };
  }

  const latestProject = latestProjectFromSessionActivity() || store.mostRecentlyEditedProject;
  startNewAgentDraft(latestProject?.id);
  return { status: 'success' };
}

export async function loadAgentModels(): Promise<ActionResult> {
  const store = useAgentStore();
  const requestVersion = ++modelsRequestVersion;
  const sessionId = store.selectedSessionId;
  const runtimeKind = store.runtimeKind;
  const { client } = activateRuntime(runtimeKind);
  const runtimeSessionId = sessionId
    ? store.sessions.find((item) => item.id === sessionId)?.runtimeId
    : undefined;
  store.modelsLoading = true;
  store.modelsError = '';
  try {
    const [catalog, accounts] = await Promise.all([
      client.listModels(runtimeSessionId), // /models：对话时可调用的模型目录
      store.runtimeCapabilities.modelConfiguration
        ? client.listProviderAccounts()
        : Promise.resolve([]),
    ]);
    if (
      requestVersion !== modelsRequestVersion ||
      store.selectedSessionId !== sessionId ||
      store.runtimeKind !== runtimeKind
    )
      return { status: 'success' };
    store.setModels(catalog);
    store.setProviderAccounts(accounts);
    return { status: 'success' };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToLoadModelList');
    return result;
  } finally {
    if (requestVersion === modelsRequestVersion) store.modelsLoading = false;
  }
}

export async function loadAgentSkills(): Promise<ActionResult> {
  const store = useAgentStore();
  const { key, query } = currentSkillsContext();
  const { client } = getAgentRuntimeContext(store.runtimeKind);
  const runtimeQuery: RuntimeSkillContext = {
    projectId: query.projectId
      ? store.projects.find((item) => item.id === query.projectId)?.runtimeId
      : undefined,
    sessionId: query.sessionId
      ? store.sessions.find((item) => item.id === query.sessionId)?.runtimeId
      : undefined,
  };
  if (!store.runtimeCapabilities.skills) {
    store.setSkills(key, []);
    return { status: 'success' };
  }
  const requestVersion = ++skillsRequestVersion;
  store.startSkillsLoading(key);
  try {
    const skills = await client.listSkills(runtimeQuery);
    if (requestVersion !== skillsRequestVersion || currentSkillsContext().key !== key) {
      return { status: 'success' };
    }
    store.setSkills(key, skills);
    return { status: 'success' };
  } catch (error) {
    const result = errorResult(error);
    if (requestVersion === skillsRequestVersion && currentSkillsContext().key === key) {
      store.failSkillsLoading(key, result.message || tr('ui.failedToLoadSkillList'));
    }
    return result;
  }
}

export async function saveAgentProvider(
  config: CreateRuntimeProviderAccount,
): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  store.modelsError = '';
  const { client } = getAgentRuntimeContext(store.runtimeKind);
  try {
    await client.createProviderAccount(config);
    store.setProviderAccounts(await client.listProviderAccounts());
    await loadAgentModels();
    return {
      status: 'success',
      message: tr('dynamic.providerSaved', { name: config.displayName }),
    };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToSaveProvider');
    return result;
  }
}

export async function updateAgentProvider(
  accountId: string,
  config: Pick<CreateRuntimeProviderAccount, 'displayName' | 'baseURL'> & { apiKey?: string },
): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    await client.updateProviderAccount(accountId, config);
    if (config.apiKey) await client.replaceProviderCredential(accountId, config.apiKey);
    await loadAgentModels();
    return {
      status: 'success',
      message: tr('dynamic.providerUpdated', { name: config.displayName }),
    };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToUpdateProvider');
    return result;
  }
}

export async function saveAgentModel(
  accountId: string,
  config: RuntimeModelConfig,
): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  const { client } = getAgentRuntimeContext(store.runtimeKind);
  try {
    const model = await client.createModel(accountId, config);
    store.setModels(await client.listModels(store.session?.runtimeId));
    if (!store.selectedModel) await selectAgentModel(model.id);
    return { status: 'success', message: tr('dynamic.modelSaved', { name: config.displayName }) };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToSaveModel');
    return result;
  }
}

export async function updateAgentModel(
  modelTargetId: string,
  config: RuntimeModelConfig,
): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  store.modelsError = '';
  const { client } = getAgentRuntimeContext(store.runtimeKind);
  try {
    await client.updateModel(modelTargetId, config);
    store.setModels(await client.listModels(store.session?.runtimeId));
    return { status: 'success', message: tr('dynamic.modelUpdated', { name: config.displayName }) };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToUpdateModel');
    return result;
  }
}

export async function removeAgentModel(model: string): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  store.modelsError = '';
  const { client } = getAgentRuntimeContext(store.runtimeKind);
  try {
    await client.deleteModel(model);
    store.setModels(await client.listModels(store.session?.runtimeId));
    return { status: 'success', message: tr('dynamic.modelDeleted', { name: model }) };
  } catch (error) {
    const result = errorResult(error);
    store.modelsError = result.message || tr('ui.failedToDeleteModel');
    return result;
  }
}

export async function selectAgentModel(modelTargetId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const previous = { model: store.selectedModel, reasoningEffort: store.selectedReasoningEffort };
  store.selectModel(modelTargetId, true);

  // 这里只需更新当前会话中的选择，不能调用本地 Runtime 的持久化接口。
  if (!store.runtimeCapabilities.modelConfiguration) return { status: 'success' };

  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    await client.setModelPreference(modelTargetId || null, store.selectedReasoningEffort);
    return { status: 'success' };
  } catch (error) {
    store.selectModel(previous.model);
    store.selectReasoningEffort(previous.reasoningEffort);
    return errorResult(error);
  }
}

export async function selectAgentReasoning(effort?: RuntimeReasoningEffort): Promise<ActionResult> {
  const store = useAgentStore();
  const previous = store.selectedReasoningEffort;
  store.selectReasoningEffort(effort);

  if (!store.runtimeCapabilities.modelConfiguration) return { status: 'success' };

  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    await client.setModelPreference(store.selectedModel || null, effort);
    return { status: 'success' };
  } catch (error) {
    store.selectReasoningEffort(previous);
    return errorResult(error);
  }
}

export async function clearAgentProviderCredential(accountId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    await client.clearProviderCredential(accountId);
    await loadAgentModels();
    return { status: 'success', message: tr('ui.apiKeyCleared') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function removeAgentProvider(accountId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = modelMutationBlocked();
  if (blocked) return blocked;
  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    await client.deleteProviderAccount(accountId);
    store.setModels(await client.listModels(store.session?.runtimeId));
    store.setProviderAccounts(await client.listProviderAccounts());
    return { status: 'success', message: tr('ui.providerAccountDeleted') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function selectAgentSession(sessionId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const target = store.sessions.find((item) => item.id === sessionId);
  if (!target) return { status: 'error', message: tr('ui.conversationDoesNotExistOrHas') };
  activateRuntime(target.runtimeKind);
  store.selectSession(sessionId);
  savePersistedAgentView({ type: 'session', id: sessionId });
  store.setGeneralError();
  const runtime = store.ensureRuntime(sessionId);
  if (runtime.hydrated || store.sessionIsActive(sessionId)) return { status: 'success' };

  const requestVersion = (historyRequestVersions.get(sessionId) || 0) + 1;
  historyRequestVersions.set(sessionId, requestVersion);
  store.setLoadingHistory(sessionId, true);
  store.setError(sessionId);
  try {
    const { client } = getAgentRuntimeContext(target.runtimeKind);
    const history = await client.getContext(target.runtimeId);
    if (historyRequestVersions.get(sessionId) !== requestVersion) return { status: 'success' };
    const contexts = agentResponsesToContexts(history.responses);
    const latest = history.responses.at(-1);
    store.setResponses(sessionId, contexts);
    store.setContextSummary(sessionId, history.context);
    store.setPendingPermissionBatch(sessionId, latest?.pending_permission_batch);
    store.setHydrated(sessionId, true);
    syncStateFromResponse(sessionId, latest);
    return { status: 'success' };
  } catch (error) {
    if (historyRequestVersions.get(sessionId) !== requestVersion) return { status: 'success' };
    const result = errorResult(error);
    store.setError(sessionId, result.message);
    store.setStatus(sessionId, 'idle');
    return result;
  } finally {
    if (historyRequestVersions.get(sessionId) === requestVersion) {
      store.setLoadingHistory(sessionId, false);
    }
  }
}

export function refreshAgentSession() {
  const store = useAgentStore();
  return store.selectedSessionId
    ? selectAgentSession(store.selectedSessionId)
    : initAgentSession(store.runtimeKind);
}

export function startNewAgentDraft(projectId?: string): ActionResult {
  const store = useAgentStore();
  const project = projectId ? store.projects.find((item) => item.id === projectId) : undefined;
  const kind = project?.runtimeKind ?? 'local';
  activateRuntime(kind);
  store.startDraft(projectId, kind);
  savePersistedAgentView(projectId ? { type: 'project', id: projectId } : { type: 'standalone' });
  return { status: 'success' };
}

export async function createNewAgentSession(projectId?: string): Promise<ActionResult> {
  const store = useAgentStore();
  store.setGeneralError();
  try {
    const project = projectId ? projectContext(projectId).project : undefined;
    const kind = project?.runtimeKind ?? store.runtimeKind;
    const { client } = getAgentRuntimeContext(kind);
    const created = await client.createSession(project?.runtimeId);
    const session = decorateSession(kind, created);
    store.setSessions([session, ...store.sessions]);
    store.selectSession(session.id);
    store.setHydrated(session.id, true);
    return { status: 'success', message: tr('ui.newConversationCreated') };
  } catch (error) {
    const result = errorResult(error);
    store.setGeneralError(result.message);
    return result;
  }
}

export async function createAgentProject(
  cwd: string,
  kind: AgentRuntimeKind = useAgentStore().runtimeKind,
): Promise<ActionResult> {
  const store = useAgentStore();
  try {
    const { client } = getAgentRuntimeContext(kind);
    const project = decorateProject(kind, await client.createProject(cwd.trim()));
    store.setProjects([...store.projects, project]);
    startNewAgentDraft(project.id);
    return { status: 'success', message: tr('ui.projectAdded') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function deleteAgentProject(projectId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = projectActivityBlocked(projectId, tr('ui.deleteProject'));
  if (blocked) return blocked;
  try {
    const { project, client } = projectContext(projectId);
    await client.deleteProject(project.runtimeId);
    const removedIds = new Set(
      store.sessions.filter((item) => item.projectId === projectId).map((item) => item.id),
    );
    store.setProjects(store.projects.filter((item) => item.id !== projectId));
    store.setSessions(store.sessions.filter((item) => item.projectId !== projectId));
    removedIds.forEach((sessionId) => store.removeRuntime(sessionId));
    if (removedIds.has(store.selectedSessionId) || store.draftProjectId === projectId) {
      const fallbackProject = store.mostRecentlyEditedProject;
      if (fallbackProject) startNewAgentDraft(fallbackProject.id);
      else startNewAgentDraft();
    }
    return { status: 'success', message: tr('ui.projectDeleted') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function renameAgentSession(sessionId: string, title: string): Promise<ActionResult> {
  const store = useAgentStore();
  try {
    const { session: current, client } = sessionContext(sessionId);
    const session = decorateSession(
      current.runtimeKind,
      await client.renameSession(current.runtimeId, title.trim() || null),
    );
    store.setSessions(store.sessions.map((item) => (item.id === sessionId ? session : item)));
    return { status: 'success', message: tr('ui.conversationRenamed') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function moveAgentSessionToProject(
  sessionId: string,
  projectId: string,
): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked =
    sessionActivityBlocked(sessionId, tr('ui.moveConversation')) ||
    projectActivityBlocked(projectId, tr('ui.moveConversationIntoProject'));
  if (blocked) return blocked;
  try {
    const { session: current, client } = sessionContext(sessionId);
    const { project } = projectContext(projectId);
    if (current.runtimeKind !== project.runtimeKind)
      return { status: 'error', message: tr('ui.conversationsCannotBeMovedBetweenDifferent') };
    const session = decorateSession(
      current.runtimeKind,
      await client.bindSessionToProject(current.runtimeId, project.runtimeId),
    );
    store.setSessions(store.sessions.map((item) => (item.id === sessionId ? session : item)));
    return { status: 'success', message: tr('ui.conversationMovedToProject') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function deleteAgentSession(sessionId: string): Promise<ActionResult> {
  const store = useAgentStore();
  const blocked = sessionActivityBlocked(sessionId, tr('ui.deleteConversation'));
  if (blocked) return blocked;
  try {
    const { session, client } = sessionContext(sessionId);
    await client.deleteSession(session.runtimeId);
    store.setSessions(store.sessions.filter((session) => session.id !== sessionId));
    store.removeRuntime(sessionId);
    if (store.selectedSessionId === sessionId) {
      const fallbackProject = store.mostRecentlyEditedProject;
      if (fallbackProject) startNewAgentDraft(fallbackProject.id);
      else startNewAgentDraft();
    }
    return { status: 'success', message: tr('ui.conversationDeleted') };
  } catch (error) {
    const result = errorResult(error);
    if (store.runtimeBySessionId[sessionId]) store.setError(sessionId, result.message);
    else store.setGeneralError(result.message);
    return result;
  }
}

type AttachmentUpdate = (
  attachmentId: string,
  changes: Partial<Pick<AgentComposerAttachment, 'status' | 'storedFile' | 'error'>>,
) => void;

export async function sendAgentMessage(
  content: AgentInputContent[],
  attachments: AgentComposerAttachment[] = [],
  updateAttachment?: AttachmentUpdate,
  permissionMode: AgentPermissionMode = 'ask',
): Promise<ActionResult> {
  const store = useAgentStore();
  const draftContextKey = store.draftContextKey;
  const draftProjectId = store.draftProjectId;
  const initialSessionId = store.selectedSessionId;
  if (!content.length && !attachments.length)
    return { status: 'error', message: tr('ui.enterAMessageOrAddAn') };
  if (!store.selectedModel)
    return { status: 'error', message: tr('ui.configureAndSelectAModelIn') };
  if (store.loadingHistory)
    return { status: 'error', message: tr('ui.conversationHistoryIsLoadingTryAgain') };
  if (draftProjectId) {
    const blocked = projectActivityBlocked(draftProjectId, tr('ui.startANewConversation'));
    if (blocked) return blocked;
  }
  const referencedSkillIds = new Set(
    content.filter((part) => part.type === 'input_skill').map((part) => part.id),
  );
  const referencedSkills = store.skills.filter((skill) => referencedSkillIds.has(skill.id));
  const selectedModel = store.selectedModel;
  const selectedReasoningEffort = store.selectedReasoningEffort;
  let sessionId = initialSessionId;
  if (!sessionId) {
    try {
      const project = draftProjectId ? projectContext(draftProjectId).project : undefined;
      const kind = project?.runtimeKind ?? store.runtimeKind;
      const { client } = getAgentRuntimeContext(kind);
      const created = decorateSession(kind, await client.createSession(project?.runtimeId));
      store.setSessions([created, ...store.sessions]);
      store.setHydrated(created.id, true);
      sessionId = created.id;
      if (store.draftContextKey === draftContextKey && !store.selectedSessionId) {
        store.moveComposerDraft(draftContextKey, `session:${created.id}`);
        store.selectSession(created.id);
      }
    } catch (error) {
      return errorResult(error);
    }
  }

  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session)
    return {
      status: 'error',
      message: tr('ui.currentConversationDoesNotExist'),
      data: { sessionId },
    };
  const { client } = getAgentRuntimeContext(session.runtimeKind);
  if (store.sessionIsActive(sessionId) || activeStreamControllers.has(sessionId)) {
    return {
      status: 'error',
      message: tr('ui.currentConversationIsRunningOrAwaiting'),
      data: { sessionId },
    };
  }
  if (session.projectId) {
    const ownerId = store.projectActivityOwner(session.projectId);
    if (ownerId && ownerId !== sessionId) {
      const owner = store.sessions.find((item) => item.id === ownerId);
      store.setConflict(sessionId, {
        sessionId: ownerId,
        responseId: store.runtimeBySessionId[ownerId]?.activeResponseId,
      });
      return {
        status: 'error',
        message: tr('dynamic.projectSessionBusy', {
          title: owner?.title || tr('ui.newConversation'),
        }),
        data: { sessionId },
      };
    }
  }

  store.setStatus(sessionId, 'running');
  store.setError(sessionId);
  store.setConflict(sessionId);
  const uploadedFiles = new Map(
    attachments.flatMap((attachment) =>
      attachment.storedFile?.session_id === session.runtimeId
        ? [[attachment.id, attachment.storedFile] as const]
        : [],
    ),
  );
  for (const attachment of attachments) {
    if (uploadedFiles.has(attachment.id)) continue;
    if (attachment.selected.source !== 'browser') {
      const message = tr('ui.agentAttachmentUploadsCurrentlySupportOnly');
      updateAttachment?.(attachment.id, { status: 'error', error: message });
      store.setStatus(sessionId, 'idle');
      store.setError(sessionId, message);
      return { status: 'error', message, data: { sessionId } };
    }
    updateAttachment?.(attachment.id, { status: 'uploading', error: '' });
    try {
      const storedFile = await client.uploadFile(
        session.runtimeId,
        attachment.selected.file,
        attachment.selected.name,
      );
      uploadedFiles.set(attachment.id, storedFile);
      updateAttachment?.(attachment.id, { status: 'uploaded', storedFile, error: '' });
      await releaseSelections([attachment.selected]);
    } catch (error) {
      const result = errorResult(error);
      updateAttachment?.(attachment.id, { status: 'error', error: result.message });
      store.setStatus(sessionId, 'idle');
      store.setError(sessionId, result.message);
      return { ...result, data: { sessionId } };
    }
  }

  const uploadedContent: AgentInputContent[] = attachments.flatMap((attachment) => {
    const file = uploadedFiles.get(attachment.id);
    return file
      ? [
          {
            type: 'input_file' as const,
            file_id: file.id,
            filename: file.filename,
            media_type: file.media_type,
            size: file.size,
          },
        ]
      : [];
  });
  const responseContent = [...uploadedContent, ...content];
  const shouldSetTitle = !session.title;
  store.setHydrated(sessionId, true);
  const now = new Date().toISOString();
  const localResponseId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  store.addResponse(
    sessionId,
    normalizeResponseContext({
      session_id: sessionId,
      input: [{ type: 'message', role: 'user', content: responseContent }],
      response: {
        id: localResponseId,
        object: 'response',
        status: 'in_progress',
        skills: responseContent
          .filter((part) => part.type === 'input_skill')
          .map((part) => ({
            id: part.id,
            name: referencedSkills.find((skill) => skill.id === part.id)?.name || part.id,
          })),
        output: [],
      },
      created_at: now,
      updated_at: now,
    }),
  );
  store.setActiveResponseId(sessionId, localResponseId);
  store.setSessions(
    store.sessions.map((item) => (item.id === sessionId ? { ...item, updated_at: now } : item)),
  );
  const controller = new AbortController();
  activeStreamControllers.set(sessionId, controller);
  try {
    await client.streamResponse(
      session.runtimeId,
      selectedModel,
      responseContent,
      selectedReasoningEffort,
      permissionMode,
      (event) => applyRuntimeEvent(sessionId, event),
      controller.signal,
    );
    await reconcileSessionContext(sessionId);
    if (shouldSetTitle) await setInitialSessionTitle(sessionId, responseContent, referencedSkills);
    return { status: 'success', data: { sessionId } };
  } catch (error) {
    if (controller.signal.aborted) return { status: 'cancelled', data: { sessionId } };
    const result = await handleRuntimeRequestError(sessionId, localResponseId, error);
    await reconcileSessionContext(sessionId);
    store.setError(sessionId, result.message);
    return { ...result, data: { sessionId } };
  } finally {
    if (activeStreamControllers.get(sessionId) === controller) {
      activeStreamControllers.delete(sessionId);
    }
  }
}

export async function downloadAgentFile(file: AIFileContent): Promise<ActionResult> {
  const store = useAgentStore();
  const sessionId = store.selectedSessionId;
  const fileId = typeof file.file_id === 'string' ? file.file_id : '';
  if (!sessionId || !fileId)
    return { status: 'error', message: tr('ui.attachmentInformationIsIncomplete') };
  try {
    const { session, client } = sessionContext(sessionId);
    const blob = await client.getFileContent(session.runtimeId, fileId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download =
      typeof file.filename === 'string' && file.filename ? file.filename : 'download_file';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { status: 'success', message: tr('ui.downloadSucceeded') };
  } catch (error) {
    return errorResult(error);
  }
}

export async function stopAgentResponse(sessionId?: string): Promise<ActionResult> {
  const store = useAgentStore();
  const targetSessionId = sessionId || store.selectedSessionId;
  const runtime = targetSessionId ? store.runtimeBySessionId[targetSessionId] : undefined;
  const responseId = runtime?.activeResponseId;
  if (!targetSessionId || !responseId || responseId.startsWith('local-')) {
    return { status: 'error', message: tr('ui.theResponseHasNotBeenCreated') };
  }
  if (!runtime || (runtime.status !== 'running' && runtime.status !== 'waiting_permission')) {
    return { status: 'error', message: tr('ui.noResponseIsCurrentlyGenerating') };
  }

  store.setStatus(targetSessionId, 'stopping');
  store.setError(targetSessionId);
  try {
    const { session, client } = sessionContext(targetSessionId);
    const response = await client.cancelResponse(session.runtimeId, responseId);
    activeStreamControllers.get(targetSessionId)?.abort();
    applyRuntimeEvent(targetSessionId, {
      type: 'response.cancelled',
      response_id: response.id,
      response,
    });
    store.setPendingPermissionBatch(targetSessionId);
    return { status: 'success', message: tr('ui.generationStopped') };
  } catch (error) {
    const result = errorResult(error);
    await reconcileSessionContext(targetSessionId);
    store.setError(targetSessionId, result.message);
    return result;
  }
}

async function setInitialSessionTitle(
  sessionId: string,
  content: AgentInputContent[],
  skills: RuntimeSkill[],
) {
  const store = useAgentStore();
  try {
    const { session: current, client } = sessionContext(sessionId);
    const session = decorateSession(
      current.runtimeKind,
      await client.renameSession(current.runtimeId, titleFromInput(content, skills)),
    );
    store.setSessions(store.sessions.map((item) => (item.id === sessionId ? session : item)));
  } catch (error) {
    store.setError(
      sessionId,
      tr('dynamic.titleUpdateFailed', { reason: errorResult(error).message ?? '' }),
    );
  }
}

export async function resolveAgentPermissionBatch(
  decisions: PermissionDecision[],
  sessionId?: string,
): Promise<ActionResult> {
  const store = useAgentStore();
  const targetSessionId = sessionId || store.selectedSessionId;
  const runtime = targetSessionId ? store.runtimeBySessionId[targetSessionId] : undefined;
  const batch = runtime?.pendingPermissionBatch;
  const responseId = runtime?.activeResponseId;
  if (!targetSessionId || !batch || !responseId) {
    return { status: 'error', message: tr('ui.noPendingPermissionRequests') };
  }
  if (decisions.length !== batch.permissions.length) {
    return { status: 'error', message: tr('ui.resolveAllPermissionRequestsInThis') };
  }
  store.setStatus(targetSessionId, 'running');
  store.setError(targetSessionId);
  const controller = new AbortController();
  activeStreamControllers.set(targetSessionId, controller);
  try {
    const { session, client } = sessionContext(targetSessionId);
    await client.streamPermission(
      session.runtimeId,
      responseId,
      batch.id,
      decisions,
      (event) => applyRuntimeEvent(targetSessionId, event),
      controller.signal,
    );
    return { status: 'success' };
  } catch (error) {
    if (controller.signal.aborted) return { status: 'cancelled' };
    const result = await handleRuntimeRequestError(targetSessionId, '', error);
    await reconcileSessionContext(targetSessionId);
    store.setError(targetSessionId, result.message);
    return result;
  } finally {
    if (activeStreamControllers.get(targetSessionId) === controller) {
      activeStreamControllers.delete(targetSessionId);
    }
  }
}

async function reconcileSessionContext(sessionId: string) {
  const store = useAgentStore();
  try {
    const { session, client } = sessionContext(sessionId);
    const history = await client.getContext(session.runtimeId);
    const latest = history.responses.at(-1);
    store.setResponses(sessionId, agentResponsesToContexts(history.responses));
    store.setContextSummary(sessionId, history.context);
    store.setPendingPermissionBatch(sessionId, latest?.pending_permission_batch);
    store.setHydrated(sessionId, true);
    syncStateFromResponse(sessionId, latest);
  } catch {
    store.setStatus(sessionId, 'idle');
  }
}

async function handleRuntimeRequestError(
  sessionId: string,
  optimisticResponseId: string,
  error: unknown,
): Promise<ActionResult> {
  const store = useAgentStore();
  if (!(error instanceof RuntimeRequestError)) return errorResult(error);

  if (optimisticResponseId) store.removeResponse(sessionId, optimisticResponseId);
  if (error.code === 'active_response_exists') {
    return { status: 'error', message: tr('ui.thisConversationAlreadyHasAResponse') };
  }
  if (error.code === 'project_active_response_exists' && error.details?.sessionId) {
    const current = store.sessions.find((item) => item.id === sessionId);
    const ownerSessionId = runtimeResourceKey(
      current?.runtimeKind ?? store.runtimeKind,
      error.details.sessionId,
    );
    store.setConflict(sessionId, {
      sessionId: ownerSessionId,
      responseId: error.details.responseId,
    });
    if (!store.sessions.some((item) => item.id === ownerSessionId)) {
      try {
        const kind = current?.runtimeKind ?? store.runtimeKind;
        const { client } = getAgentRuntimeContext(kind);
        const sessions = (await client.listSessions()).map((item) => decorateSession(kind, item));
        store.setRuntimeSessions(kind, sessions);
      } catch {
        // The conflict message still remains useful if refreshing the sidebar fails.
      }
    }
    if (store.sessions.some((item) => item.id === ownerSessionId)) {
      await reconcileSessionContext(ownerSessionId);
    }
    const owner = store.sessions.find((item) => item.id === ownerSessionId);
    return {
      status: 'error',
      message: tr('dynamic.projectSessionBusy', {
        title: owner?.title || tr('ui.newConversation'),
      }),
    };
  }
  return errorResult(error);
}

function applyRuntimeEvent(sessionId: string, event: RuntimeStreamEvent) {
  const store = useAgentStore();
  const runtime = store.ensureRuntime(sessionId);
  if (event.type === 'response.created') {
    const response = event.response as AgentResponse;
    const optimistic = runtime.responses.find(
      (item) => item.response.id === runtime.activeResponseId,
    );
    const initial = normalizeResponseContext({
      session_id: response.session_id || sessionId,
      input: response.input?.length ? response.input : optimistic?.input,
      response,
      created_at: response.created_at || optimistic?.createdAt,
      updated_at: response.updated_at,
    });
    if (optimistic?.response.id.startsWith('local-')) {
      store.removeResponse(sessionId, optimistic.response.id);
    }
    const reduced = reduceResponseEvent(initial, event);
    store.upsertResponse(sessionId, reduced.context);
    store.setActiveResponseId(sessionId, reduced.context.response.id);
    store.setStatus(sessionId, 'running');
    return;
  }

  const responseId =
    typeof event.response_id === 'string' ? event.response_id : runtime.activeResponseId;
  const context = store.findResponse(sessionId, responseId);
  if (!context) return;
  if (event.type === 'agent.permissions.requested') {
    const permissionEvent = event as AgentPermissionEvent;
    const alreadyPending = runtime.pendingPermissionBatch?.id === permissionEvent.batch?.id;
    context.response.status = 'waiting_permission';
    context.updatedAt = new Date().toISOString();
    store.upsertResponse(sessionId, context);
    store.setPendingPermissionBatch(sessionId, permissionEvent.batch);
    syncStateFromResponse(sessionId, { id: responseId, status: 'waiting_permission' });
    if (!alreadyPending && permissionEvent.batch?.permissions.length) {
      const first = permissionEvent.batch.permissions[0];
      const summary =
        first.prompt || tr('dynamic.toolRequestsAction', { name: first.tool_call.name });
      const count = permissionEvent.batch.permissions.length;
      notifyAgentEvent(
        sessionId,
        'permission_requested',
        count > 1
          ? tr('dynamic.reviewRequests', { summary, count })
          : tr('dynamic.reviewRequest', { summary }),
      );
    }
    return;
  }
  if (event.type === 'agent.permissions.resolved') {
    applyPermissionResolutions(context, (event as AgentPermissionEvent).decisions);
    store.upsertResponse(sessionId, context);
    store.setPendingPermissionBatch(sessionId);
    // The permission endpoint starts a new SSE request.  Its first event is the
    // resolution, so waiting for a later output item would leave the UI stuck on
    // the old pending permission state while the tool is already executing.
    syncStateFromResponse(sessionId, {
      id: responseId,
      status: 'in_progress',
    });
    return;
  }

  const previousStatus = context.response.status;
  const reduced = reduceResponseEvent(context, event);
  store.upsertResponse(sessionId, reduced.context);
  if (reduced.status === 'failed' || reduced.status === 'incomplete') {
    store.setError(sessionId, reduced.message || tr('ui.agentFailedToRun'));
  }
  if (reduced.status !== 'streaming')
    syncStateFromResponse(sessionId, {
      id: reduced.context.response.id,
      status: reduced.context.response.status,
    });
  if (reduced.status === 'completed' && previousStatus !== 'completed') {
    notifyAgentEvent(sessionId, 'completed', tr('ui.agentFinishedResponding'));
  }
}

/** Apply the runtime-only permission transition to the corresponding output items. */
function applyPermissionResolutions(
  context: AIResponseContext,
  decisions: AgentPermissionEvent['decisions'],
) {
  const decisionsByPermissionId = new Map(
    (decisions || []).map((decision) => [decision.permission_id, decision]),
  );

  for (const item of context.response.output) {
    if (item.type !== 'permission_request') continue;
    const permission = item as unknown as PermissionRequestItem;
    const decision = decisionsByPermissionId.get(permission.permission_id);
    if (!decision) continue;
    permission.status = decision.decision === 'approve' ? 'approved' : 'denied';
    if (decision.decision === 'deny' && decision.reason) {
      permission.denial_reason = decision.reason;
    }
  }

  // These fields describe the live response, rather than the final persisted
  // item snapshot.  The following tool/result and terminal SSE events remain
  // authoritative and will replace this state when they arrive.
  context.response.status = 'in_progress';
  context.updatedAt = new Date().toISOString();
}
