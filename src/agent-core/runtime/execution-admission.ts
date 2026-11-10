import type { AgentRunRecord } from './agent-domain.js';
import type { Session, WorkspaceStore } from './workspace-store.js';

export interface ActiveResponseReference {
  sessionId: string;
  responseId: string;
  rootSessionId?: string
}

export interface ResponseExecutionScope {
  key: string; // project:project_id or session:rootSession_id, means only one active tree per project
  type: 'project' | 'session';
  id: string; // project id or rootSession id
  sessionId?: string;
  rootSessionId?: string;
}

/**
 * record each scope(project) entry:
 *  1. operation is recorded in reservations through ExecutionAdmission.reserve
 *  2. reservation transfer to holders through ExecutionAdmission.activate
 */
interface ScopeEntry {
  holders: Map<string, ActiveResponseReference>;
  reservations: Map<symbol, ResponseExecutionScope>;
  maintenanceCount: number; // wheter is maintaining, 0 or 1
}

export interface ResponseScopeReservation {
  readonly scope: ResponseExecutionScope;
  readonly token: symbol
}

export class ResponseScopeConflictError extends Error {
  constructor(readonly scope: ResponseExecutionScope, readonly holder?: ActiveResponseReference) {
    super(holder ? `Response execution scope is occupied by ${holder.responseId}.` : 'Response execution scope is temporarily unavailable.');
  }
}

/** A project admits one tree, and a tree admits at most one run per session. */
export class ExecutionAdmission {
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly workspaceStore: WorkspaceStore) {}

  reserve(session: Session): Promise<ResponseScopeReservation> {
    const scope = executionScopeForSession(session);
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recover(entry, session);
      this.assertAvailable(scope, entry);
      const token = Symbol(scope.key);
      entry.reservations.set(token, scope);
      return { scope, token };
    });
  }

  activate(reservation: ResponseScopeReservation, holder: ActiveResponseReference): void {
    const entry = this.entry(reservation.scope.key);
    if (!entry.reservations.delete(reservation.token)) throw new Error('Response reservation is no longer current.');
    entry.holders.set(holder.sessionId, structuredClone(holder));
  }

  releaseReservation(reservation: ResponseScopeReservation): Promise<void> {
    return this.serialized(reservation.scope.key, async () => {
      const entry = this.entry(reservation.scope.key);
      entry.reservations.delete(reservation.token);
      this.prune(reservation.scope.key, entry);
    });
  }

  ensureHolder(session: Session, run: AgentRunRecord): Promise<void> {
    const scope = executionScopeForSession(session);
    const expected = activeResponseReference(run, session);
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recover(entry, session);
      const existing = entry.holders.get(expected.sessionId);
      if (existing?.responseId === expected.responseId) return;
      this.assertAvailable(scope, entry);
      entry.holders.set(expected.sessionId, structuredClone(expected));
    });
  }

  release(session: Session, run: AgentRunRecord): Promise<void> {
    const scope = executionScopeForSession(session);
    const holder = activeResponseReference(run, session);
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.holders.get(holder.sessionId)?.responseId === holder.responseId) entry.holders.delete(holder.sessionId);
      this.prune(scope.key, entry);
    });
  }

  async withSessionMaintenance<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const session = await this.workspaceStore.getSession(sessionId);
    return this.withMaintenance(
      session
        ? executionScopeForSession(session)
        : { key: `session:${sessionId}`, type: "session", id: sessionId },
      operation, true,
    );
  }

  async withIdleSessionMaintenance<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const session = await this.workspaceStore.getSession(sessionId);
    const scope = session
      ? executionScopeForSession(session)
      : { key: `session:${sessionId}`, type: "session" as const, id: sessionId };
    return this.withMaintenance(scope, async () => {
      if (session) {
        const active = await this.workspaceStore.findActiveResponseInScope(session);
        if (active) {
          throw new ResponseScopeConflictError(scope, activeResponseReference(active));
        }
      }
      return operation();
    });
  }

  withProjectMaintenance<T>(projectId: string, operation: () => Promise<T>, stopPreparing = false): Promise<T> {
    return this.withMaintenance(
      { key: `project:${projectId}`, type: "project", id: projectId },
      operation, stopPreparing,
    );
  }

  /**
   * run operation and use entry.maintenanceCount to prevent new reservations.
   * @param stopPreparing whether this operation can ignore entry.maintenanceCount
   */
  private async withMaintenance<T>(scope: ResponseExecutionScope, operation: () => Promise<T>, stopPreparing = false): Promise<T> {
    await this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.maintenanceCount || (!stopPreparing && entry.reservations.size)) throw new ResponseScopeConflictError(scope);
      entry.maintenanceCount++;
    });
    try { return await operation(); }
    finally {
      await this.serialized(scope.key, async () => {
        const entry = this.entry(scope.key);
        entry.maintenanceCount--;
        this.prune(scope.key, entry);
      });
    }
  }

  private assertAvailable(scope: ResponseExecutionScope, entry: ScopeEntry): void {
    if (entry.maintenanceCount) throw new ResponseScopeConflictError(scope);
    for (const holder of entry.holders.values()) {
      if (holder.sessionId === scope.sessionId || holder.rootSessionId !== scope.rootSessionId) throw new ResponseScopeConflictError(scope, holder);
    }
    for (const pending of entry.reservations.values()) {
      if (pending.sessionId === scope.sessionId || pending.rootSessionId !== scope.rootSessionId) throw new ResponseScopeConflictError(scope);
    }
  }

  private async recover(entry: ScopeEntry, session: Session): Promise<void> {
    const runs = await this.workspaceStore.activeRunsForProjectScope(session);
    for (const run of runs) {
      const holder = activeResponseReference(run, await this.workspaceStore.getSession(run.sessionId));
      if (!entry.holders.has(holder.sessionId)) entry.holders.set(holder.sessionId, holder);
    }
  }

  private entry(key: string): ScopeEntry {
    let entry = this.entries.get(key);
    if (!entry) { entry = { holders: new Map(), reservations: new Map(), maintenanceCount: 0 }; this.entries.set(key, entry); }
    return entry;
  }

  private prune(key: string, entry: ScopeEntry): void {
    if (!entry.holders.size && !entry.reservations.size && !entry.maintenanceCount) this.entries.delete(key);
  }

  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    return result;
  }
}

export function executionScopeForSession(session: Session): ResponseExecutionScope {
  const rootSessionId = session.rootSessionId ?? session.id;
  return session.projectId
    ? { key: `project:${session.projectId}`, type: 'project', id: session.projectId, sessionId: session.id, rootSessionId }
    : { key: `session:${rootSessionId}`, type: 'session', id: rootSessionId, sessionId: session.id, rootSessionId };
}

export function activeResponseReference(run: AgentRunRecord, session?: Session): ActiveResponseReference {
  return { sessionId: run.sessionId, responseId: run.id, rootSessionId: session?.rootSessionId ?? run.sessionId };
}
