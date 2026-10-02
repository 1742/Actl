import { defineStore } from "pinia";
import type { AIResponseContext } from "../types/aiResponse";
import type {
  AgentComposerAttachment,
  AgentComposerContextKey,
  AgentComposerDocument,
  AgentPermissionMode,
  AgentRuntimeCapabilities,
  AgentRuntimeAvailability,
  AgentRuntimeKind,
  AgentRuntimeConflict,
  AgentSessionRuntime,
  SessionContextSummary,
  AgentViewStatus,
  RuntimeModel,
  RuntimeModelCatalog,
  RuntimeProviderAccount,
  RuntimeReasoningEffort,
  RuntimeProject,
  RuntimeSession,
  RuntimeSkill,
} from "../types";
import { useRuntimeStore } from "../../stores/runtime";

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
      sessionProjectBinding: true,
      localProjectPaths: true,
    } as AgentRuntimeCapabilities,
    models: [] as RuntimeModel[],
    providerAccounts: [] as RuntimeProviderAccount[],
    selectedModel: "",
    selectedReasoningEffort: undefined as RuntimeReasoningEffort | undefined,
    selectedPermissionMode: "accept_edits" as AgentPermissionMode,
    modelsLoading: false,
    modelsLoaded: false,
    modelsError: "",
    skills: [] as RuntimeSkill[],
    skillsLoading: false,
    skillsLoaded: false,
    skillsError: "",
    skillsContextKey: "",
    projects: [] as RuntimeProject[],
    sessions: [] as RuntimeSession[],
    selectedSessionId: "",
    draftProjectId: "",
    runtimeBySessionId: {} as Record<string, AgentSessionRuntime>,
    composerDrafts: {} as Record<string, AgentComposerDocument>,
    attachmentDrafts: {} as Record<string, AgentComposerAttachment[]>,
    generalError: "",
    initialized: false,
  }),

  getters: {
    baseUrl: () => {
      const runtime = useRuntimeStore();
      return runtime.agentUrl;
    },
    session: (state) => state.sessions.find((item) => item.id === state.selectedSessionId),
    draftProject: (state) => state.projects.find((item) => item.id === state.draftProjectId),
    currentRuntime: (state) => (
      state.selectedSessionId ? state.runtimeBySessionId[state.selectedSessionId] : undefined
    ),
    responses: (state): AIResponseContext[] => (
      state.runtimeBySessionId[state.selectedSessionId]?.responses || []
    ),
    status: (state): AgentViewStatus => (
      state.runtimeBySessionId[state.selectedSessionId]?.status || "idle"
    ),
    pendingPermissionBatch: (state) => (
      state.runtimeBySessionId[state.selectedSessionId]?.pendingPermissionBatch
    ),
    activeResponseId: (state) => (
      state.runtimeBySessionId[state.selectedSessionId]?.activeResponseId || ""
    ),
    errorMessage: (state) => (
      state.runtimeBySessionId[state.selectedSessionId]?.errorMessage || state.generalError
    ),
    loadingHistory: (state) => (
      state.runtimeBySessionId[state.selectedSessionId]?.loadingHistory || false
    ),
    draftContextKey: (state): AgentComposerContextKey => (
      state.selectedSessionId
        ? `session:${state.selectedSessionId}`
        : state.draftProjectId ? `project:${state.draftProjectId}:draft` : `standalone:${state.runtimeKind}:draft`
    ),
    mostRecentlyEditedProject: (state) => [...state.projects].sort((a, b) => (
      projectActivityAt(b, state.sessions).localeCompare(projectActivityAt(a, state.sessions))
    ))[0],
    isRunning: (state): boolean => {
      const status = state.runtimeBySessionId[state.selectedSessionId]?.status;
      return status === "running" || status === "stopping";
    },
    isStopping: (state): boolean => (
      state.runtimeBySessionId[state.selectedSessionId]?.status === "stopping"
    ),
    isWaitingPermission: (state): boolean => (
      state.runtimeBySessionId[state.selectedSessionId]?.status === "waiting_permission"
    ),
    activeSessionIds: (state) => Object.entries(state.runtimeBySessionId)
      .filter(([, runtime]) => isActiveStatus(runtime.status))
      .map(([sessionId]) => sessionId),
    hasActiveResponse: (state): boolean => Object.values(state.runtimeBySessionId)
      .some((runtime) => isActiveStatus(runtime.status)),
    projectActivityOwner: (state) => (projectId: string) => {
      const session = state.sessions.find((item) => (
        item.projectId === projectId && isActiveStatus(state.runtimeBySessionId[item.id]?.status || "idle")
      ));
      return session?.id;
    },
    sessionIsActive: (state) => (sessionId: string) => (
      isActiveStatus(state.runtimeBySessionId[sessionId]?.status || "idle")
    ),
    standaloneSessions: (state) => state.sessions.filter((item) => !item.projectId).sort(byUpdated),
    sessionsByProject: (state) => (projectId: string) => (
      state.sessions.filter((item) => item.projectId === projectId).sort(byUpdated)
    ),
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
    selectReasoningEffort(effort?: RuntimeReasoningEffort) {
      this.selectedReasoningEffort = effort;
    },
    selectPermissionMode(mode: AgentPermissionMode) {
      this.selectedPermissionMode = mode;
    },
    setProjects(projects: RuntimeProject[]) { this.projects = projects; },
    setSessions(sessions: RuntimeSession[]) { this.sessions = sessions; },
    setRuntimeProjects(kind: AgentRuntimeKind, projects: RuntimeProject[]) {
      this.projects = [...this.projects.filter((item) => item.runtimeKind !== kind), ...projects];
    },
    setRuntimeSessions(kind: AgentRuntimeKind, sessions: RuntimeSession[]) {
      this.sessions = [...this.sessions.filter((item) => item.runtimeKind !== kind), ...sessions];
    },
    selectSession(sessionId: string) {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (session) this.runtimeKind = session.runtimeKind;
      this.selectedSessionId = sessionId;
      this.draftProjectId = "";
      this.ensureRuntime(sessionId);
    },
    ensureRuntime(sessionId: string) {
      if (!this.runtimeBySessionId[sessionId]) {
        this.runtimeBySessionId[sessionId] = createSessionRuntime();
      }
      return this.runtimeBySessionId[sessionId];
    },
    removeRuntime(sessionId: string) {
      delete this.runtimeBySessionId[sessionId];
      delete this.composerDrafts[`session:${sessionId}`];
      delete this.attachmentDrafts[`session:${sessionId}`];
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
      return this.ensureRuntime(sessionId).responses.find((context) => context.response.id === responseId);
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
