import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  ProjectRecord,
  FileChangeRecord,
  SessionContentRecord,
  SessionContextStateRecord,
  ContextCompressionRecord,
  SessionMetadataRecord,
  TimelineItemUpdate,
  WorkspaceRepository,
} from "../repositories/workspace-repository.js";
import type { TranscriptItem, TranscriptMessage } from "../model/types.js";
import { buildModelTranscript, findUnresolvedToolCalls, type AgentRunRecord } from "./agent-domain.js";
import { createRandomId, nowIso } from "../utils.js";
import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import type { RunPermissionSnapshot } from "../permissions/engine.js";

export type Project = ProjectRecord;
export type FileChange = FileChangeRecord;
type SessionMetadata = SessionMetadataRecord;

export interface Session extends SessionMetadata {
  cwd: string | null;
  runs: AgentRunRecord[];
  fileChanges: FileChange[];
  contextState?: SessionContextStateRecord;
  compressionRecords: ContextCompressionRecord[];
}

export type WorkspaceStoreErrorCode =
  | "project_already_exists"
  | "project_cwd_invalid"
  | "project_not_found"
  | "session_already_bound"
  | "session_not_found";

export class WorkspaceStoreError extends Error {
  constructor(readonly code: WorkspaceStoreErrorCode, message: string) {
    super(message);
  }
}

export class WorkspaceStore {
  private projects: Project[] = [];
  private sessionMetadata: SessionMetadata[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly loadedSessionIds = new Set<string>();
  private readonly providerResponseIds = new Map<string, string[]>();
  private readonly persistedTimelinePayloads = new Map<string, string[]>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly repository: WorkspaceRepository) {}

  //初始化
  async initialize(): Promise<void> {
    const index = await this.repository.initialize();
    this.projects = index.projects;
    this.sessionMetadata = index.sessions;
    this.sessions.clear();
    this.loadedSessionIds.clear();
    this.providerResponseIds.clear();
    this.persistedTimelinePayloads.clear();
    for (const metadata of this.sessionMetadata) {
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
  async createProject(ownerId: string, cwd: string, name?: string): Promise<Project> {
    const normalizedCwd = path.resolve(cwd);
    await assertProjectDirectory(normalizedCwd);
    let created!: Project;
    await this.enqueue(async () => {
      if (this.projects.some((item) => item.ownerId === ownerId && cwdKey(item.cwd) === cwdKey(normalizedCwd))) {
        throw new WorkspaceStoreError("project_already_exists", "A project already exists for this cwd.");
      }
      const now = nowIso();
      created = {
        id: createRandomId("project"),
        ownerId,
        cwd: normalizedCwd,
        ...(name === undefined ? {} : { name }),
        created_at: now,
        updated_at: now,
      };
      await this.repository.createProject(created);
      this.projects.push(created);
    });
    return structuredClone(created);
  }

  //更新project
  async updateProject(ownerId: string, id: string, name: string | undefined): Promise<Project> {
    let updated!: Project;
    await this.enqueue(async () => {
      const index = this.projects.findIndex((item) => item.id === id && item.ownerId === ownerId);
      const project = this.projects[index];
      if (!project) throw new WorkspaceStoreError("project_not_found", "Project not found.");
      updated = {
        ...project,
        ...(name === undefined ? {} : { name }),
        updated_at: nowIso(),
      };
      if (name === undefined) delete updated.name;
      await this.repository.updateProject(updated);
      this.projects[index] = updated;
    });
    return structuredClone(updated);
  }

  //删除project
  async deleteProject(ownerId: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.projects.some((item) => item.id === id && item.ownerId === ownerId)) {
        throw new WorkspaceStoreError("project_not_found", "Project not found.");
      }
      const sessionIds = this.sessionMetadata.filter((item) => item.ownerId === ownerId && item.projectId === id).map((item) => item.id);
      await this.repository.deleteProject(id);
      this.projects = this.projects.filter((item) => item.id !== id || item.ownerId !== ownerId);
      this.sessionMetadata = this.sessionMetadata.filter((item) => item.projectId !== id || item.ownerId !== ownerId);
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
  async getSession(id: string, ownerId?: string): Promise<Session | undefined> {
    const session = this.sessions.get(id);
    if (!session || (ownerId !== undefined && session.ownerId !== ownerId)) return undefined;
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
          await this.repository.updateRun(run, snapshot.updates, run.timeline.length, updatedAt);
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
  async createSession(ownerId: string, input: { projectId?: string; title?: string } = {}): Promise<Session> {
    let created!: Session;
    await this.enqueue(async () => {
      if (input.projectId !== undefined && !this.projects.some((item) => item.id === input.projectId && item.ownerId === ownerId)) {
        throw new WorkspaceStoreError("project_not_found", "Project not found.");
      }
      const now = nowIso();
      const metadata: SessionMetadata = {
        id: createRandomId("session"),
        ownerId,
        projectId: input.projectId ?? null,
        ...(input.title === undefined ? {} : { title: input.title }),
        created_at: now,
        updated_at: now,
      };
      created = this.toSession(metadata);
      await this.repository.createSession(metadata);
      this.sessionMetadata.push(metadata);
      this.sessions.set(created.id, created);
      this.loadedSessionIds.add(created.id);
    });
    return created;
  }

  //更新会话
  async updateSession(ownerId: string, id: string, title: string | undefined): Promise<Session> {
    let updated!: Session;
    await this.enqueue(async () => {
      const index = this.sessionMetadata.findIndex((item) => item.id === id && item.ownerId === ownerId);
      const metadata = this.sessionMetadata[index];
      if (!metadata) throw new WorkspaceStoreError("session_not_found", "Session not found.");
      const replacement: SessionMetadata = {
        ...metadata,
        ...(title === undefined ? {} : { title }),
        updated_at: nowIso(),
      };
      if (title === undefined) delete replacement.title;
      await this.repository.updateSession(replacement);
      this.sessionMetadata[index] = replacement;
      updated = this.applyMetadata(replacement);
    });
    return updated;
  }

  async bindSession(ownerId: string, id: string, projectId: string): Promise<Session> {
    let bound!: Session;
    await this.enqueue(async () => {
      const metadata = this.requireOwnedSessionMetadata(id, ownerId);
      if (metadata.projectId !== null) {
        throw new WorkspaceStoreError("session_already_bound", "Session is already bound to a project.");
      }
      if (!this.projects.some((item) => item.id === projectId && item.ownerId === ownerId)) {
        throw new WorkspaceStoreError("project_not_found", "Project not found.");
      }
      const replacement: SessionMetadata = { ...metadata, projectId, updated_at: nowIso() };
      await this.repository.updateSession(replacement);
      this.sessionMetadata[this.sessionMetadata.indexOf(metadata)] = replacement;
      bound = this.applyMetadata(replacement);
    });
    return bound;
  }

  async deleteSession(ownerId: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      this.requireOwnedSessionMetadata(id, ownerId);
      await this.repository.deleteSession(id);
      this.sessionMetadata = this.sessionMetadata.filter((item) => item.id !== id);
      this.evictSession(id);
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
      await this.repository.appendFileChange(fileChange);
      session.fileChanges.push(fileChange);
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
      await this.repository.trimFileChanges(sessionId, keep, updatedAt);
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
      await this.repository.createRun(response);
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
    const sessionIds = session.projectId === null
      ? [session.id]
      : this.sessionMetadata.filter((metadata) => metadata.ownerId === session.ownerId && metadata.projectId === session.projectId).map((metadata) => metadata.id);
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
      await this.repository.updateRun(response, snapshot.updates, response.timeline.length, now);
      this.persistedTimelinePayloads.set(response.id, snapshot.payloads);
    });
  }

  async recordProviderResponseId(responseId: string, providerResponseId: string): Promise<void> {
    const ids = this.providerResponseIds.get(responseId) ?? [];
    if (ids.includes(providerResponseId)) return;
    await this.enqueue(async () => {
      await this.repository.appendProviderResponseId(responseId, providerResponseId);
      ids.push(providerResponseId);
      this.providerResponseIds.set(responseId, ids);
    });
  }

  async recordModelUsage(session: Session, responseId: string, step: number, usage: import("../model/types.js").ModelUsage): Promise<void> {
    const now = nowIso();
    await this.enqueue(async () => {
      await this.repository.appendModelInvocationUsage({ runId: responseId, step, ...usage, createdAt: now });
      const prior = session.contextState;
      const next: SessionContextStateRecord = {
        sessionId: session.id, summary: prior?.summary ?? "", summarizedRunCount: prior?.summarizedRunCount ?? 0,
        ...(usage.inputTokens === undefined ? (prior?.lastInputTokens === undefined ? {} : { lastInputTokens: prior.lastInputTokens }) : { lastInputTokens: usage.inputTokens }),
        updatedAt: now,
      };
      await this.repository.saveSessionContext(next);
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
      await this.repository.saveSessionContext(state);
      await this.repository.appendContextCompression({
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
    return this.repository.loadSessionContent(id);
  }

  private requireSessionMetadata(id: string): SessionMetadata {
    const metadata = this.sessionMetadata.find((item) => item.id === id);
    if (!metadata) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    return metadata;
  }

  private requireOwnedSessionMetadata(id: string, ownerId: string): SessionMetadata {
    const metadata = this.sessionMetadata.find((item) => item.id === id && item.ownerId === ownerId);
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

  private applyMetadata(metadata: SessionMetadata): Session {
    const session = this.sessions.get(metadata.id);
    if (!session) throw new WorkspaceStoreError("session_not_found", "Session not found.");
    Object.assign(session, metadata, { cwd: this.resolveCwd(metadata.projectId) });
    if (metadata.title === undefined) delete session.title;
    return session;
  }

  private toSession(metadata: SessionMetadata): Session {
    return { ...metadata, cwd: this.resolveCwd(metadata.projectId), runs: [], fileChanges: [], compressionRecords: [] };
  }

  private resolveCwd(projectId: string | null): string | null {
    return projectId === null ? null : this.projects.find((item) => item.id === projectId)?.cwd ?? null;
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
  const relative = path.relative(session.cwd, absolute);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
    ? relative
    : absolute;
}

function cwdKey(cwd: string): string {
  const normalized = path.normalize(cwd).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function assertProjectDirectory(cwd: string): Promise<void> {
  try {
    if ((await stat(cwd)).isDirectory()) return;
  } catch {
    // The public error below deliberately does not expose filesystem details.
  }
  throw new WorkspaceStoreError("project_cwd_invalid", "Project workspace path must exist and be a directory.");
}
