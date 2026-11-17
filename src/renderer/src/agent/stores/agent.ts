import { defineStore } from "pinia";
import type { AIResponseContext } from '../components/responses/types';
import type { AgentComposerAttachment, AgentComposerContextKey, AgentComposerDocument } from '../components/composer/types';
import type { PendingPermissionBatchDto, PermissionMode } from '../../../../shared/agent/responses';
import type { AgentRuntimeCapabilities, AgentRuntimeKind } from '../services/runtimeClient';
import type { SessionContextSummary } from '../../../../shared/agent/sessions';
import type { RuntimeModel, RuntimeModelCatalog, RuntimeProviderAccount, ReasoningEffort } from '../../../../shared/agent/models';
import type { RuntimeProject, RuntimeSession } from '../components/navigation/types';
import type { RuntimeSkill } from '../../../../shared/agent/skills';
import type { AgentPlan, AgentTask, ChildRunResult } from '../../../../shared/agent/coordination';

type AgentRuntimeAvailability = "idle" | "checking" | "available" | "unavailable";

interface AgentRuntimeConflict {
  sessionId: string;
  responseId?: string;
}

interface AgentSessionRuntime {
  responses: AIResponseContext[];
  status: AgentViewStatus;
  pendingPermissionBatch?: PendingPermissionBatchDto;
  activeResponseId: string;
  errorMessage: string;
  loadingHistory: boolean;
  hydrated: boolean;
  conflict?: AgentRuntimeConflict;
  context?: SessionContextSummary;
  compressionInProgress: boolean;
}

type AgentViewStatus = "idle" | "running" | "waiting_permission" | "stopping";

interface AgentTreeMember {
  session: RuntimeSession;
  runtime: AgentSessionRuntime;
  waiting: boolean;
}

interface AgentTree {
  rootId: string;
  runtimeKind: AgentRuntimeKind;
  members: Record<string, AgentTreeMember>;
  plan: AgentPlan;
  tasks: AgentTask[];
  childRunResults: ChildRunResult[];
}

export interface PermissionTarget {
  sessionId: string;
  responseId: string;
  batchId: string;
}

export interface TreePermissionRequest extends PermissionTarget {
  session: RuntimeSession;
  batch: PendingPermissionBatchDto;
  task?: AgentTask | undefined;
}

export function sessionTreeId(session: RuntimeSession) {
  return session.rootSessionId ? `${session.runtimeKind}:${session.rootSessionId}` : session.id;
}

const byUpdated = (a: RuntimeSession, b: RuntimeSession) => b.updated_at.localeCompare(a.updated_at);
function projectActivityAt(project: RuntimeProject, sessions: RuntimeSession[]) {
  const latestSession = sessions
    .filter((session) => session.projectId === project.id)
    .sort(byUpdated)[0];
  return latestSession?.updated_at || project.updated_at;
}

function createSessionRuntime(): AgentSessionRuntime {
  return {
    responses: [],
    status: "idle",
    activeResponseId: "",
    errorMessage: "",
    loadingHistory: false,
    hydrated: false,
    compressionInProgress: false,
  };
}

function isActiveStatus(status: AgentViewStatus) {
  return status === "running" || status === "stopping" || status === "waiting_permission";
}

export const useAgentStore = defineStore("agent", {
  state: () => ({
    runtimeKind: "local" as AgentRuntimeKind,
    runtimeAvailability: {
      local: "idle",
    } as Record<AgentRuntimeKind, AgentRuntimeAvailability>,
    runtimeErrors: { local: "" } as Record<AgentRuntimeKind, string>,
    runtimeCapabilities: {
      modelConfiguration: true,
      skills: true,
      workspace: true,
      permissions: true,
      localProjectPaths: true,
    } as AgentRuntimeCapabilities,
    models: [] as RuntimeModel[],
    providerAccounts: [] as RuntimeProviderAccount[],
    selectedModel: "",
    selectedReasoningEffort: undefined as ReasoningEffort | undefined,
    selectedPermissionMode: "accept_edits" as PermissionMode,
    modelsLoading: false,
    modelsLoaded: false,
    modelsError: "",
    skills: [] as RuntimeSkill[],
    skillsLoading: false,
    skillsLoaded: false,
    skillsError: "",
    skillsContextKey: "",
    projects: [] as RuntimeProject[],
    trees: {} as Record<string, AgentTree>,
    selectedSessionId: "",
    draftProjectId: "",
    composerDrafts: {} as Record<string, AgentComposerDocument>,
    attachmentDrafts: {} as Record<string, AgentComposerAttachment[]>,
    generalError: "",
    initialized: false,
  }),

  getters: {
    membersBySessionId: (state): Record<string, AgentTreeMember> => Object.assign(
      {}, ...Object.values(state.trees).map((tree) => tree.members),
    ),
    sessions(): RuntimeSession[] { return Object.values(this.membersBySessionId).map(({ session }) => session); },
    sessionById() { return (id: string) => this.membersBySessionId[id]?.session; },
    runtimeBySessionId() { return (id: string) => this.membersBySessionId[id]?.runtime; },
    session(): RuntimeSession | undefined { return this.sessionById(this.selectedSessionId); },
    currentTree(): AgentTree | undefined { return this.session && this.trees[sessionTreeId(this.session)]; },
    currentRuntime(): AgentSessionRuntime | undefined { return this.runtimeBySessionId(this.selectedSessionId); },
    permissionRequests(): TreePermissionRequest[] {
      const tree = this.currentTree;
      if (!tree) return [];
      return Object.values(tree.members).flatMap(({ session, runtime }) => {
        const batch = runtime.pendingPermissionBatch;
        if (!batch || runtime.activeResponseId !== batch.response_id) return [];
        return [{
          sessionId: session.id, responseId: batch.response_id, batchId: batch.id, session, batch,
          task: tree.tasks.find(({ attempt }) => attempt?.ownerSessionId === session.runtimeId && attempt.outcome === 'active'),
        }];
      }).sort((a, b) => Number(b.sessionId === tree.rootId) - Number(a.sessionId === tree.rootId)
        || a.batch.created_at.localeCompare(b.batch.created_at));
    },
    draftProject: (state) => state.projects.find((item) => item.id === state.draftProjectId),
    responses(): AIResponseContext[] { return this.currentRuntime?.responses ?? []; },
    status(): AgentViewStatus { return this.currentRuntime?.status ?? "idle"; },
    pendingPermissionBatch(): PendingPermissionBatchDto | undefined { return this.currentRuntime?.pendingPermissionBatch; },
    activeResponseId(): string { return this.currentRuntime?.activeResponseId ?? ""; },
    errorMessage(): string { return this.currentRuntime?.errorMessage || this.generalError; },
    loadingHistory(): boolean { return this.currentRuntime?.loadingHistory ?? false; },
    draftContextKey: (state): AgentComposerContextKey => (
      state.selectedSessionId
        ? `session:${state.selectedSessionId}`
        : state.draftProjectId ? `project:${state.draftProjectId}:draft` : `standalone:${state.runtimeKind}:draft`
    ),
    mostRecentlyEditedProject(): RuntimeProject | undefined {
      return [...this.projects].sort((a, b) => projectActivityAt(b, this.sessions).localeCompare(projectActivityAt(a, this.sessions)))[0];
    },
    isRunning(): boolean { return this.status === "running" || this.status === "stopping"; },
    isStopping(): boolean { return this.status === "stopping"; },
    isWaitingPermission(): boolean { return this.status === "waiting_permission"; },
    activeSessionIds(): string[] {
      return Object.values(this.membersBySessionId).filter(({ runtime }) => isActiveStatus(runtime.status))
        .map(({ session }) => session.id);
    },
    hasActiveResponse(): boolean { return this.activeSessionIds.length > 0; },
    projectActivityOwner() {
      return (projectId: string) => this.activeSessionIds.find((id) => this.sessionById(id)?.projectId === projectId);
    },
    sessionIsActive() {
      return (id: string) => isActiveStatus(this.runtimeBySessionId(id)?.status ?? "idle");
    },
    standaloneSessions(): RuntimeSession[] { return this.sessions.filter((item) => !item.projectId && !item.parentSessionId).sort(byUpdated); },
    sessionsByProject() {
      return (projectId: string) => this.sessions.filter((item) => item.projectId === projectId && !item.parentSessionId).sort(byUpdated);
    },
  },

  actions: {
    /** change available models and skills */
    configureRuntime(kind: AgentRuntimeKind, capabilities: AgentRuntimeCapabilities) {
      if (this.runtimeKind !== kind) {
        this.runtimeKind = kind;
        this.models = [];
        this.providerAccounts = [];
        this.selectedModel = "";
        this.modelsLoaded = false;
        this.skills = [];
        this.skillsLoaded = false;
        this.skillsContextKey = "";
      }
      this.runtimeCapabilities = { ...capabilities };
    },
    setRuntimeAvailability(kind: AgentRuntimeKind, availability: AgentRuntimeAvailability, error = "") {
      this.runtimeAvailability[kind] = availability;
      this.runtimeErrors[kind] = error;
    },
    setModels(catalog: RuntimeModelCatalog) {
      this.models = catalog.data;
      const selectable = (item: RuntimeModel) => item.enabled && item.compatible !== false;
      const current = catalog.data.some((item) => item.id === this.selectedModel && selectable(item)) ? this.selectedModel : "";
      const preferred = catalog.data.find((item) => item.id === catalog.selectedModelTargetId && selectable(item))?.id;
      const selectedModel = current || preferred || catalog.data.find(selectable)?.id || "";
      this.selectModel(selectedModel);
      const selected = catalog.data.find((item) => item.id === selectedModel);
      if (catalog.selectedReasoningEffort && selected?.capabilities.reasoningEfforts.includes(catalog.selectedReasoningEffort)) {
        this.selectedReasoningEffort = catalog.selectedReasoningEffort;
      }
      this.modelsLoaded = true;
    },
    setProviderAccounts(accounts: RuntimeProviderAccount[]) { this.providerAccounts = accounts; },
    setSkills(contextKey: string, skills: RuntimeSkill[]) {
      this.skillsContextKey = contextKey;
      this.skills = skills;
      this.skillsLoaded = true;
      this.skillsLoading = false;
      this.skillsError = "";
    },
    startSkillsLoading(contextKey: string) {
      this.skillsContextKey = contextKey;
      this.skills = [];
      this.skillsLoading = true;
      this.skillsLoaded = false;
      this.skillsError = "";
    },
    failSkillsLoading(contextKey: string, message: string) {
      this.skillsContextKey = contextKey;
      this.skills = [];
      this.skillsLoading = false;
      this.skillsLoaded = false;
      this.skillsError = message;
    },
    selectModel(model: string, resetReasoning = false) {
      this.selectedModel = model;
      const capabilities = this.models.find((item) => item.id === model)?.capabilities;
      if (!capabilities) { this.selectedReasoningEffort = undefined; return; }
      if (!resetReasoning && this.selectedReasoningEffort && capabilities.reasoningEfforts.includes(this.selectedReasoningEffort)) return;
      this.selectedReasoningEffort = capabilities.defaultReasoningEffort ?? capabilities.reasoningEfforts[0];
    },
    selectReasoningEffort(effort?: ReasoningEffort) {
      this.selectedReasoningEffort = effort;
    },
    selectPermissionMode(mode: PermissionMode) {
      this.selectedPermissionMode = mode;
    },
    setProjects(projects: RuntimeProject[]) { this.projects = projects; },
    setRuntimeProjects(kind: AgentRuntimeKind, projects: RuntimeProject[]) {
      this.projects = [...this.projects.filter((item) => item.runtimeKind !== kind), ...projects];
    },
    setRuntimeSessions(kind: AgentRuntimeKind, sessions: RuntimeSession[]) {
      const seen = new Set(sessions.map(({ id }) => id));
      for (const session of this.sessions) {
        if (session.runtimeKind === kind && !seen.has(session.id)) this.removeSession(session.id);
      }
      for (const session of sessions) this.upsertSession(session);
    },
    upsertSession(session: RuntimeSession) {
      const rootId = sessionTreeId(session);
      const tree = this.trees[rootId];
      const existing = tree?.members[session.id];
      if (existing) {
        existing.session = session;
        return;
      }

      const member = { session, runtime: createSessionRuntime(), waiting: false };
      if (tree) {
        tree.members[session.id] = member;
      } else {
        // Publish the new tree and its first member together for synchronous watchers.
        this.trees[rootId] = {
          rootId, runtimeKind: session.runtimeKind, members: { [session.id]: member },
          plan: { revision: 0, items: [] }, tasks: [], childRunResults: [],
        };
      }
    },
    setTreeDetails(rootId: string, members: { session: RuntimeSession; waiting?: boolean | undefined }[],
      plan: AgentPlan, tasks: AgentTask[], childRunResults: ChildRunResult[]) {
      for (const { session, waiting } of members) {
        this.upsertSession(session);
        this.trees[rootId]!.members[session.id]!.waiting = waiting ?? false;
      }
      const tree = this.trees[rootId];
      if (!tree) return;
      const seen = new Set(members.map(({ session }) => session.id));
      for (const id of Object.keys(tree.members)) {
        if (id !== rootId && !seen.has(id)) this.removeSession(id);
      }
      tree.plan = plan;
      tree.tasks = tasks;
      tree.childRunResults = childRunResults;
    },
    selectSession(sessionId: string) {
      const session = this.sessionById(sessionId);
      if (session) this.runtimeKind = session.runtimeKind;
      this.selectedSessionId = sessionId;
      this.draftProjectId = "";
    },
    ensureRuntime(sessionId: string) {
      const runtime = this.runtimeBySessionId(sessionId);
      if (!runtime) throw new Error(`Unknown agent session: ${sessionId}`);
      return runtime;
    },
    removeSession(sessionId: string) {
      const session = this.sessionById(sessionId);
      if (!session) return;
      const rootId = sessionTreeId(session);
      const tree = this.trees[rootId]!;
      const removed = sessionId === rootId ? Object.keys(tree.members) : [sessionId];
      for (const id of removed) {
        delete tree.members[id];
        this.clearComposerDraft(`session:${id}`);
        this.clearAttachmentDraft(`session:${id}`);
      }
      if (!Object.keys(tree.members).length) delete this.trees[rootId];
    },
    setResponses(sessionId: string, responses: AIResponseContext[]) {
      this.ensureRuntime(sessionId).responses = responses;
    },
    addResponse(sessionId: string, context: AIResponseContext) {
      this.ensureRuntime(sessionId).responses.push(context);
    },
    removeResponse(sessionId: string, responseId: string) {
      const runtime = this.ensureRuntime(sessionId);
      runtime.responses = runtime.responses.filter((context) => context.response.id !== responseId);
    },
    findResponse(sessionId: string, responseId: string) {
      return this.runtimeBySessionId(sessionId)?.responses.find((context) => context.response.id === responseId);
    },
    upsertResponse(sessionId: string, context: AIResponseContext) {
      const runtime = this.ensureRuntime(sessionId);
      const index = runtime.responses.findIndex((current) => current.response.id === context.response.id);
      if (index >= 0) runtime.responses[index] = context;
      else runtime.responses.push(context);
    },
    setStatus(sessionId: string, status: AgentViewStatus) {
      this.ensureRuntime(sessionId).status = status;
    },
    setError(sessionId: string, message = "") {
      this.ensureRuntime(sessionId).errorMessage = message;
    },
    setGeneralError(message = "") {
      this.generalError = message;
    },
    setConflict(sessionId: string, conflict?: AgentRuntimeConflict) {
      this.ensureRuntime(sessionId).conflict = conflict;
    },
    setLoadingHistory(sessionId: string, loading: boolean) {
      this.ensureRuntime(sessionId).loadingHistory = loading;
    },
    setHydrated(sessionId: string, hydrated: boolean) {
      this.ensureRuntime(sessionId).hydrated = hydrated;
    },
    setActiveResponseId(sessionId: string, responseId: string) {
      this.ensureRuntime(sessionId).activeResponseId = responseId;
    },
    setPendingPermissionBatch(sessionId: string, batch?: AgentSessionRuntime["pendingPermissionBatch"]) {
      this.ensureRuntime(sessionId).pendingPermissionBatch = batch;
    },
    setContextSummary(sessionId: string, context: SessionContextSummary) {
      this.ensureRuntime(sessionId).context = context;
    },
    setCompressionInProgress(sessionId: string, inProgress: boolean) {
      this.ensureRuntime(sessionId).compressionInProgress = inProgress;
    },
    setComposerDraft(key: AgentComposerContextKey, draft: AgentComposerDocument) {
      this.composerDrafts[key] = draft;
    },
    clearComposerDraft(key: AgentComposerContextKey) {
      delete this.composerDrafts[key];
    },
    setAttachmentDraft(key: AgentComposerContextKey, attachments: AgentComposerAttachment[]) {
      this.attachmentDrafts[key] = attachments;
    },
    clearAttachmentDraft(key: AgentComposerContextKey) {
      delete this.attachmentDrafts[key];
    },
    moveComposerDraft(source: AgentComposerContextKey, target: AgentComposerContextKey) {
      const document = this.composerDrafts[source];
      const attachments = this.attachmentDrafts[source];
      if (document) this.composerDrafts[target] = document;
      if (attachments) this.attachmentDrafts[target] = attachments;
      delete this.composerDrafts[source];
      delete this.attachmentDrafts[source];
    },
    startDraft(projectId?: string, runtimeKind?: AgentRuntimeKind) {
      const project = projectId ? this.projects.find((item) => item.id === projectId) : undefined;
      if (project) this.runtimeKind = project.runtimeKind;
      else if (runtimeKind) this.runtimeKind = runtimeKind;
      this.selectedSessionId = "";
      this.draftProjectId = projectId || "";
      this.generalError = "";
    },
    resetConversation() {
      this.startDraft();
    },
  },
});
