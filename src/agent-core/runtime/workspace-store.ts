import { mkdir, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectSettings } from "../../shared/agent/sessions.js";
import { workspaceDirectoryName, workspacePathKey } from "../tools/path-security.js";
import type {
  FileChangeRecord,
  SessionContentRecord,
  SessionContextStateRecord,
  ContextCompressionRecord,
  SessionRecord,
  TimelineItemUpdate,
  SessionRepository,
} from "../repositories/session-repository.js";
import type { ProjectRecord, ProjectRepository } from "../repositories/project-repository.js";
import type { TranscriptItem, TranscriptMessage } from "../model/types.js";
import { buildModelTranscript, findUnresolvedToolCalls, type AgentRunRecord } from "./agent-domain.js";
import { createRandomId, nowIso } from "../utils.js";
import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import type { RunPermissionSnapshot } from "../permissions/engine.js";

export type Project = ProjectRecord;
export type FileChange = FileChangeRecord;
export interface Session extends SessionRecord {
  cwd: string | null;
  additionalWorkspacePaths?: string[];
  runs: AgentRunRecord[];
  fileChanges: FileChange[];
  contextState?: SessionContextStateRecord;
  compressionRecords: ContextCompressionRecord[];
}

export type WorkspaceStoreErrorCode =
  | "project_already_exists"
  | "project_cwd_invalid"
  | "project_workspaces_invalid"
  | "project_not_found"
  | "session_not_found";

export class WorkspaceStoreError extends Error {
  constructor(readonly code: WorkspaceStoreErrorCode, message: string) {
    super(message);
  }
}

export class WorkspaceStore {
  private projects: Project[] = [];
  private sessionsRecord: SessionRecord[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly loadedSessionIds = new Set<string>();
  private readonly loadingSessions = new Map<string, Promise<Session | undefined>>();
  private readonly providerResponseIds = new Map<string, string[]>();
  private readonly persistedTimelinePayloads = new Map<string, string[]>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly standaloneWorkspaceRoot: string,
  ) {}

  //初始化
  async initialize(): Promise<void> {
    const [projects, sessions] = await Promise.all([
      this.projectRepository.listProjects(),
      this.sessionRepository.listSessions(),
    ]);
    this.projects = projects;
    this.sessionsRecord = sessions;
    this.sessions.clear();
    this.loadedSessionIds.clear();
    this.providerResponseIds.clear();
    this.persistedTimelinePayloads.clear();
    for (const metadata of this.sessionsRecord) {
      this.sessions.set(metadata.id, this.toSession(metadata));
    }
  }

  //深拷贝
  listProjects(ownerId: string): Project[] {
    return structuredClone(this.projects.filter((item) => item.ownerId === ownerId));
  }

  //按id获取project
  getProject(id: string, ownerId: string): Project | undefined {
    const project = this.projects.find((item) => item.id === id && item.ownerId === ownerId);
    return project ? structuredClone(project) : undefined;
  }

  //创建project
  async createProject(ownerId: string, settings: ProjectSettings): Promise<Project> {
    let created!: Project;
    await this.enqueue(async () => {
      const workspaceSettings = await this.resolveProjectWorkspaces(ownerId, settings);
      const now = nowIso();
      created = {
        id: createRandomId("project"),
        ownerId,
        ...workspaceSettings,
        name: settings.name ?? workspaceDirectoryName(workspaceSettings.cwd),
        created_at: now,
        updated_at: now,
      };
      await this.projectRepository.createProject(created);
      this.projects.push(created);
    });
    return structuredClone(created);
  }

  //更新project
  async updateProject(ownerId: string, id: string, settings: ProjectSettings): Promise<Project> {
    let updated!: Project;
    await this.enqueue(async () => {
      const index = this.projects.findIndex((item) => item.id === id && item.ownerId === ownerId);
      const project = this.projects[index];
      if (!project) throw new WorkspaceStoreError("project_not_found", "Project not found.");
      updated = {
        ...project,
        ...await this.resolveProjectWorkspaces(ownerId, settings, project),
        name: settings.name ?? project.name ?? workspaceDirectoryName(project.cwd),
        updated_at: nowIso(),
      };
      await this.projectRepository.updateProject(updated);
      this.projects[index] = updated;
      for (const session of this.sessions.values()) {
        if (session.ownerId === ownerId && session.projectId === id) {
          Object.assign(session, projectSessionDirectories(updated));
        }
      }
    });
    return structuredClone(updated);
  }

  private async resolveProjectWorkspaces(ownerId: string, settings: ProjectSettings, previous?: Project) {
    const existing = new Map((previous?.workspaces ?? []).map((workspace) => [workspacePathKey(workspace.path), workspace]));
    const attached = new Map<string, { projectId: string; workspace: Project["workspaces"][number] }>();
    const lookupAttached = async () => {
      const bindings = this.projects.filter((project) => project.ownerId === ownerId)
        .flatMap((project) => project.workspaces.map((workspace) => ({ projectId: project.id, workspace })));
      for (const binding of bindings) attached.set(workspacePathKey(binding.workspace.path), binding);
      for (const binding of bindings) {
        const canonical = await realpath(binding.workspace.path).catch(() => binding.workspace.path);
        const key = workspacePathKey(canonical);
        if (!attached.has(key)) attached.set(key, binding);
      }
    };
    let lookedUpAttached = false;
    const primaryKey = workspacePathKey(path.resolve(settings.primaryWorkspacePath));
    const selected = new Set<string>();
    const workspaces: Project["workspaces"] = [];
    let primary: Project["workspaces"][number] | undefined;
    for (const directory of settings.workspacePaths) {
      const resolved = path.resolve(directory);
      const inputKey = workspacePathKey(resolved);
      const previousBinding = existing.get(inputKey);
      const canonical = previousBinding ? await realpath(previousBinding.path).catch(() => previousBinding.path) : await projectDirectory(resolved);
      let retained = previousBinding;
      const key = workspacePathKey(canonical);
      if (selected.has(key)) {
        throw new WorkspaceStoreError("project_workspaces_invalid", "A workspace cannot be added to the same project twice.");
      }
      if (!retained) {
        if (!lookedUpAttached) {
          await lookupAttached();
          lookedUpAttached = true;
        }
        const canonicalBinding = attached.get(key);
        if ([attached.get(inputKey), canonicalBinding].some((bound) => bound && bound.projectId !== previous?.id)) {
          throw new WorkspaceStoreError("project_already_exists", "This workspace already belongs to another project.");
        }
        retained = canonicalBinding?.workspace;
      }
      const workspace = retained ?? { id: createRandomId("workspace"), path: canonical };
      selected.add(key);
      workspaces.push(workspace);
      if (inputKey === primaryKey) primary = workspace;
    }
    if (!primary) {
      throw new WorkspaceStoreError("project_workspaces_invalid", "Select a primary workspace from the project's directories.");
    }
    if (previous && primary.id !== previous.primaryWorkspaceId) await projectDirectory(primary.path);
    return { workspaces, primaryWorkspaceId: primary.id, cwd: primary.path };
  }

  //删除project
  async deleteProject(ownerId: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.projects.some((item) => item.id === id && item.ownerId === ownerId)) {
        throw new WorkspaceStoreError("project_not_found", "Project not found.");
      }
      const sessionIds = this.sessionsRecord.filter((item) => item.ownerId === ownerId && item.projectId === id).map((item) => item.id);
      await this.projectRepository.deleteProject(id);
      this.projects = this.projects.filter((item) => item.id !== id || item.ownerId !== ownerId);
      this.sessionsRecord = this.sessionsRecord.filter((item) => item.projectId !== id || item.ownerId !== ownerId);
      for (const sessionId of sessionIds) this.evictSession(sessionId);
    });
  }

  //深拷贝指定项目id的会话
  listSessions(ownerId: string, projectId?: string | null): Session[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId && (projectId === undefined || session.projectId === projectId))
      .map((session) => structuredClone(session));
  }

  //按id获取会话
  hasSession(id: string, ownerId: string): boolean {
    return this.sessions.get(id)?.ownerId === ownerId;
  }

  async getSession(id: string, ownerId?: string): Promise<Session | undefined> {
    const metadata = this.sessions.get(id);
    if (!metadata || (ownerId !== undefined && metadata.ownerId !== ownerId)) return undefined;
    const pending = this.loadingSessions.get(id);
    if (pending) return pending;
    const loading = this.loadSession(id, ownerId);
    this.loadingSessions.set(id, loading);
    try { return await loading; }
    finally { if (this.loadingSessions.get(id) === loading) this.loadingSessions.delete(id); }
  }

  private async loadSession(id: string, ownerId?: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session || (ownerId !== undefined && session.ownerId !== ownerId)) return undefined;
    if (session.projectId === null) {
      await mkdir(this.standaloneWorkspacePath(session.rootSessionId ?? id), { recursive: true });
      if (this.sessions.get(id) !== session) return undefined;
    }
    if (this.loadedSessionIds.has(id)) return session;

    const content = await this.loadSessionContent(id);
    // Before recovering, record all the timeline payloads so we can re-attach them
    const persistedTimelinePayloads = new Map(content.runs.map((run) => [
      run.id,
      run.timeline.map((item) => JSON.stringify(item)),
    ]));
    const recoveredRunIds = await this.recoverSessionContent(content);
    session.runs = structuredClone(content.runs);
    session.fileChanges = structuredClone(content.fileChanges ?? []);
    session.compressionRecords = structuredClone(content.compressionRecords);
    if (content.contextState) session.contextState = structuredClone(content.contextState);
    else delete session.contextState;
    if (recoveredRunIds.size > 0) {
      const updatedAt = nowIso();
      const metadata = this.requireSessionMetadata(session.id);
      metadata.updated_at = updatedAt;
      session.updated_at = updatedAt;
      await this.enqueue(async () => {
        for (const run of session.runs) {
          if (!recoveredRunIds.has(run.id)) continue;
          const snapshot = timelineUpdateSnapshot(run, persistedTimelinePayloads.get(run.id) ?? []);
          await this.sessionRepository.updateRun(run, snapshot.updates, run.timeline.length, updatedAt);
        }
      });
    }
    for (const [responseId, ids] of Object.entries(content.provider_response_ids)) {
      this.providerResponseIds.set(responseId, [...ids]);
    }
    this.loadedSessionIds.add(id);
    for (const run of session.runs) {
      this.persistedTimelinePayloads.set(run.id, run.timeline.map((item) => JSON.stringify(item)));
    }
    return session;
  }

  //创建会话
  async createSession(ownerId: string, input: { projectId?: string; title?: string; parentSessionId?: string; originRunId?: string; originCallId?: string } = {}): Promise<Session> {
    let created!: Session;
    await this.enqueue(async () => {
      if (input.projectId !== undefined && !this.projects.some((item) => item.id === input.projectId && item.ownerId === ownerId)) {
        throw new WorkspaceStoreError("project_not_found", "Project not found.");
      }
      const now = nowIso();
      const parent = input.parentSessionId ? this.requireOwnedSessionRecord(input.parentSessionId, ownerId) : undefined;
      if (parent && parent.projectId !== (input.projectId ?? null)) throw new Error('Child project must match its parent.');
      const id = createRandomId('session');
      const metadata: SessionRecord = {
        id,
        rootSessionId: parent?.rootSessionId ?? parent?.id ?? id,
        ...(parent ? { parentSessionId: parent.id } : {}),
        ...(input.originRunId ? { originRunId: input.originRunId } : {}),
        ...(input.originCallId ? { originCallId: input.originCallId } : {}),
        ownerId,
        projectId: input.projectId ?? null,
        ...(input.title === undefined ? {} : { title: input.title }),
        created_at: now,
        updated_at: now,
      };
      created = this.toSession(metadata);
      const workspace = metadata.projectId === null && !parent ? this.standaloneWorkspacePath(metadata.id) : undefined;
      if (workspace) {
        await mkdir(this.standaloneWorkspaceRoot, { recursive: true });
        await mkdir(workspace);
      }
      try {
        await this.sessionRepository.createSession(metadata);
      } catch (error) {
        if (workspace) await rmdir(workspace).catch(() => undefined);
        throw error;
      }
      this.sessionsRecord.push(metadata);
      this.sessions.set(created.id, created);
      this.loadedSessionIds.add(created.id);
    });
    return created;
  }

  //更新会话
  async updateSession(ownerId: string, id: string, title: string | undefined): Promise<Session> {
    let updated!: Session;
    await this.enqueue(async () => {
      const index = this.sessionsRecord.findIndex((item) => item.id === id && item.ownerId === ownerId);
      const metadata = this.sessionsRecord[index];
      if (!metadata) throw new WorkspaceStoreError("session_not_found", "Session not found.");
      const replacement: SessionRecord = {
        ...metadata,
        ...(title === undefined ? {} : { title }),
        updated_at: nowIso(),
      };
      if (title === undefined) delete replacement.title;
      await this.sessionRepository.updateSession(replacement);
      this.sessionsRecord[index] = replacement;
      updated = this.applyMetadata(replacement);
    });
    return updated;
  }

  async deleteSession(ownerId: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      this.requireOwnedSessionRecord(id, ownerId);
      await this.sessionRepository.deleteSession(id);
      const ids = new Set(this.descendants(id).map((item) => item.id));
      this.sessionsRecord = this.sessionsRecord.filter((item) => !ids.has(item.id));
      for (const childId of ids) this.evictSession(childId);
    });
  }

  /** Older persisted runs, and a process killed while a tool was executing,
    can contain a call without its result. Repair terminal runs on load so
    their transcript can safely be sent to every model provider.
  **/
  async recoverSessionContent(content: SessionContentRecord): Promise<Set<string>> {
    const recoveredRunIds = new Set<string>();
    for (const run of content.runs) {
      if (run.status === "in_progress") {
        run.status = "failed";
        run.error = {
          code: "runtime_interrupted",
          message: "Agent execution was interrupted by server restart.",
        };
        run.completedAt = nowIso();
        run.updatedAt = run.completedAt;
        delete run.pendingToolBatch;
        recoveredRunIds.add(run.id);
      }
      if (run.status !== "waiting_permission") {
        if (run.pendingToolBatch) {
          delete run.pendingToolBatch;
          recoveredRunIds.add(run.id);
        }
        for (const toolCall of findUnresolvedToolCalls(run.timeline)) {
          run.timeline.push({
            id: createRandomId("fco"),
            type: "tool_result",
            callId: toolCall.callId,
            content: [{
              type: "json",
              value: {
                ok: false,
                error: "Tool call was interrupted before a result was recorded.",
              },
            }],
            isError: true,
          });
          recoveredRunIds.add(run.id);
        }
      }
    }
    return recoveredRunIds;
  }

  async addFileChange(
    session: Session,
    change: Omit<FileChange, "id" | "sessionId" | "created_at">,
  ): Promise<FileChange> {
    this.requireSessionMetadata(session.id);
    const fileChange: FileChange = {
      id: createRandomId("fc"),
      sessionId: session.id,
      ...change,
      filePath: normalizeFilePath(session, change.filePath),
      created_at: nowIso(),
    };
    await this.enqueue(async () => {
      const index = change.runId === undefined ? -1 : session.fileChanges.findIndex(
        (previous) => previous.runId === change.runId && workspacePathKey(previous.filePath) === workspacePathKey(fileChange.filePath),
      );
      const previous = session.fileChanges[index];
      if (previous) {
        fileChange.id = previous.id;
        fileChange.changeType = previous.changeType;
        if (previous.oldContent === undefined) delete fileChange.oldContent;
        else fileChange.oldContent = previous.oldContent;
      }
      await this.sessionRepository.appendFileChange(fileChange);
      if (previous) session.fileChanges[index] = fileChange;
      else session.fileChanges.push(fileChange);
      const metadata = this.requireSessionMetadata(session.id);
      metadata.updated_at = fileChange.created_at;
      session.updated_at = fileChange.created_at;
    });
    return structuredClone(fileChange);
  }

  getFileChanges(sessionId: string, filePath?: string): FileChange[] {
    const session = this.requireLoadedSession(sessionId);
    const changes = filePath === undefined
      ? session.fileChanges
      : session.fileChanges.filter((change) => change.filePath === normalizeFilePath(session, filePath));
    return structuredClone(changes);
  }

  getRecentFileChanges(sessionId: string, limit = 10): FileChange[] {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer.");
    return this.getFileChanges(sessionId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, limit);
  }

  async trimFileChanges(sessionId: string, keep = 50): Promise<void> {
    if (!Number.isInteger(keep) || keep < 0) throw new RangeError("keep must be a non-negative integer.");
    const session = this.requireLoadedSession(sessionId);
    if (session.fileChanges.length <= keep) return;
    const retained = this.getRecentFileChanges(sessionId, keep);
    const updatedAt = nowIso();
    await this.enqueue(async () => {
      await this.sessionRepository.trimFileChanges(sessionId, keep, updatedAt);
      session.fileChanges = retained;
      const metadata = this.requireSessionMetadata(sessionId);
      metadata.updated_at = updatedAt;
      session.updated_at = updatedAt;
    });
  }

  async createResponse(
    session: Session,
    input: TranscriptMessage[],
    modelSnapshot: ModelExecutionSnapshot,
    permissionSnapshot: RunPermissionSnapshot,
  ): Promise<AgentRunRecord> {
    const now = nowIso();
    const response: AgentRunRecord = {
      id: createRandomId("resp"),
      sessionId: session.id,
      status: "in_progress",
      modelSnapshot: structuredClone(modelSnapshot),
      permissionSnapshot: structuredClone(permissionSnapshot),
      input,
      timeline: [],
      createdAt: now,
      updatedAt: now,
      nextSequenceNumber: 0,
    };
    await this.enqueue(async () => {
      await this.sessionRepository.createRun(response);
      session.runs.push(response);
      session.updated_at = now;
      this.requireSessionMetadata(session.id).updated_at = now;
      this.persistedTimelinePayloads.set(response.id, []);
    });
    return response;
  }

  getResponse(sessionId: string, responseId: string): AgentRunRecord | undefined {
    return this.sessions.get(sessionId)?.runs.find((item) => item.id === responseId);
  }

  listResponses(sessionId: string): AgentRunRecord[] {
    const session = this.sessions.get(sessionId);
    if (!session) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    return session.runs;
  }

  async findActiveResponseInScope(session: Session): Promise<AgentRunRecord | undefined> {
    // find all sessions in same tree or project
    const candidates = session.projectId === null
      ? this.sessionsRecord.filter((item) => (item.rootSessionId ?? item.id) === (session.rootSessionId ?? session.id)) // same tree
      : this.sessionsRecord.filter((item) => item.ownerId === session.ownerId && item.projectId === session.projectId); // same project
    return this.findActiveResponse(candidates.filter((item) => item.id === session.id ||
      (item.rootSessionId ?? item.id) !== (session.rootSessionId ?? session.id)).map((item) => item.id));
  }

  descendants(id: string): Session[] {
    const ids = new Set([id]);
    for (;;) {
      const size = ids.size;
      for (const item of this.sessionsRecord) if (item.parentSessionId && ids.has(item.parentSessionId)) ids.add(item.id);
      if (ids.size === size) break;
    }
    return [...ids].flatMap((key) => this.sessions.get(key) ? [this.sessions.get(key)!] : []);
  }

  async activeRunsForProjectScope(session: Session): Promise<AgentRunRecord[]> {
    const ids = this.sessionsRecord.filter((item) => item.ownerId === session.ownerId &&
      (session.projectId !== null ? item.projectId === session.projectId : (item.rootSessionId ?? item.id) === (session.rootSessionId ?? session.id)));
    const result: AgentRunRecord[] = [];
    for (const item of ids) {
      const loaded = await this.getSession(item.id);
      result.push(...(loaded?.runs.filter((run) => run.status === 'in_progress' || run.status === 'waiting_permission') ?? []));
    }
    return result;
  }

  findActiveResponseInProject(ownerId: string, projectId: string): Promise<AgentRunRecord | undefined> {
    return this.findActiveResponse(this.sessionsRecord.filter((metadata) => metadata.ownerId === ownerId && metadata.projectId === projectId)
      .map((metadata) => metadata.id));
  }

  private async findActiveResponse(sessionIds: string[]): Promise<AgentRunRecord | undefined> {
    for (const sessionId of sessionIds) {
      const scopedSession = await this.getSession(sessionId);
      const active = scopedSession?.runs.find((run) => run.status === "in_progress" || run.status === "waiting_permission");
      if (active) return active;
    }
    return undefined;
  }

  async touch(session: Session, response: AgentRunRecord): Promise<void> {
    const now = nowIso();
    response.updatedAt = now;
    session.updated_at = now;
    this.requireSessionMetadata(session.id).updated_at = now;
    const snapshot = timelineUpdateSnapshot(response, this.persistedTimelinePayloads.get(response.id) ?? []);
    await this.enqueue(async () => {
      await this.sessionRepository.updateRun(response, snapshot.updates, response.timeline.length, now);
      this.persistedTimelinePayloads.set(response.id, snapshot.payloads);
    });
  }

  async recordProviderResponseId(responseId: string, providerResponseId: string): Promise<void> {
    const ids = this.providerResponseIds.get(responseId) ?? [];
    if (ids.includes(providerResponseId)) return;
    await this.enqueue(async () => {
      await this.sessionRepository.appendProviderResponseId(responseId, providerResponseId);
      ids.push(providerResponseId);
      this.providerResponseIds.set(responseId, ids);
    });
  }

  async recordModelUsage(session: Session, responseId: string, step: number, usage: import("../model/types.js").ModelUsage): Promise<void> {
    const now = nowIso();
    await this.enqueue(async () => {
      await this.sessionRepository.appendModelInvocationUsage({ runId: responseId, step, ...usage, createdAt: now });
      const prior = session.contextState;
      const next: SessionContextStateRecord = {
        sessionId: session.id, summary: prior?.summary ?? "", summarizedRunCount: prior?.summarizedRunCount ?? 0,
        ...(usage.inputTokens === undefined ? (prior?.lastInputTokens === undefined ? {} : { lastInputTokens: prior.lastInputTokens }) : { lastInputTokens: usage.inputTokens }),
        updatedAt: now,
      };
      await this.sessionRepository.saveSessionContext(next);
      session.contextState = next;
    });
  }

  async saveSessionSummary(session: Session, summary: string, summarizedRunCount: number): Promise<void> {
    const now = nowIso();
    const state: SessionContextStateRecord = {
      sessionId: session.id, summary, summarizedRunCount,
      ...(session.contextState?.lastInputTokens === undefined ? {} : { lastInputTokens: session.contextState.lastInputTokens }), updatedAt: now,
    };
    await this.enqueue(async () => {
      await this.sessionRepository.saveSessionContext(state);
      await this.sessionRepository.appendContextCompression({
        sessionId: session.id, summary, summarizedRunCount, createdAt: now,
      });
      session.contextState = state;
      session.compressionRecords.push({ sessionId: session.id, summary, summarizedRunCount, createdAt: now });
    });
  }

  getProviderResponseIds(responseId: string): string[] {
    return [...(this.providerResponseIds.get(responseId) ?? [])];
  }

  getModelContext(session: Session): TranscriptItem[] {
    return buildModelTranscript(session.runs, session.contextState?.summarizedRunCount ?? 0);
  }

  private async loadSessionContent(id: string): Promise<SessionContentRecord> {
    this.requireSessionMetadata(id);
    return this.sessionRepository.loadSessionContent(id);
  }

  private requireSessionMetadata(id: string): SessionRecord {
    const metadata = this.sessionsRecord.find((item) => item.id === id);
    if (!metadata) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    return metadata;
  }

  private requireOwnedSessionRecord(id: string, ownerId: string): SessionRecord {
    const metadata = this.sessionsRecord.find((item) => item.id === id && item.ownerId === ownerId);
    if (!metadata) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    return metadata;
  }

  private requireLoadedSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    if (!this.loadedSessionIds.has(id)) {
      throw new Error("Session content must be loaded with getSession() before accessing file changes.");
    }
    return session;
  }

  private applyMetadata(metadata: SessionRecord): Session {
    const session = this.sessions.get(metadata.id);
    if (!session) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    Object.assign(session, metadata);
    if (metadata.title === undefined) delete session.title;
    return session;
  }

  private toSession(metadata: SessionRecord): Session {
    const project = this.projects.find((item) => item.id === metadata.projectId && item.ownerId === metadata.ownerId);
    const directories = project ? projectSessionDirectories(project)
      : { cwd: metadata.projectId === null ? this.standaloneWorkspacePath(metadata.rootSessionId ?? metadata.id) : null };
    return { ...metadata, ...directories, runs: [], fileChanges: [], compressionRecords: [] };
  }

  private standaloneWorkspacePath(sessionId: string): string {
    return path.join(this.standaloneWorkspaceRoot, sessionId);
  }

  private evictSession(id: string): void {
    const session = this.sessions.get(id);
    if (session) for (const response of session.runs) {
      this.providerResponseIds.delete(response.id);
      this.persistedTimelinePayloads.delete(response.id);
    }
    this.sessions.delete(id);
    this.loadedSessionIds.delete(id);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = pending;
    return pending;
  }
}

function timelineUpdateSnapshot(
  run: AgentRunRecord,
  persisted: readonly string[],
): { updates: TimelineItemUpdate[]; payloads: string[] } {
  const payloads = run.timeline.map((item) => JSON.stringify(item));
  const updates = run.timeline.flatMap((item, order): TimelineItemUpdate[] =>
    payloads[order] === persisted[order] ? [] : [{ order, item }],
  );
  return { updates, payloads };
}

function normalizeFilePath(session: Session, filePath: string): string {
  if (!session.cwd) return path.normalize(filePath);
  const absolute = path.resolve(session.cwd, filePath);
  if (session.projectId !== null) return absolute;
  const relative = path.relative(session.cwd, absolute);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? relative
    : absolute;
}

function projectSessionDirectories(project: Project) {
  return {
    cwd: project.cwd,
    additionalWorkspacePaths: project.workspaces.filter((workspace) => workspace.id !== project.primaryWorkspaceId)
      .map((workspace) => workspace.path),
  };
}

async function projectDirectory(cwd: string): Promise<string> {
  try {
    const canonical = await realpath(cwd);
    if ((await stat(canonical)).isDirectory()) return canonical;
  } catch {
    // The public error below deliberately does not expose filesystem details.
  }
  throw new WorkspaceStoreError("project_cwd_invalid", "Project workspace path must exist and be a directory.");
}
