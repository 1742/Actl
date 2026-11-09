import type { AgentRunRecord } from '../agent-domain.js';
import type { Session } from '../workspace-store.js';

export interface ActiveResponseReference { 
  sessionId: string; 
  responseId: string; 
  rootSessionId?: string 
}

export interface ResponseExecutionScope {
  key: string; 
  type: 'project' | 'session'; 
  id: string;
  sessionId?: string; 
  rootSessionId?: string;
}

interface ScopeEntry {
  holders: Map<string, ActiveResponseReference>;
  reservations: Map<symbol, ResponseExecutionScope>;
  maintenanceCount: number;
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

type Recover = () => Promise<ActiveResponseReference[]>;

/** A project admits one tree, and a tree admits at most one run per session. */
export class ResponseConcurrencyCoordinator {
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly queues = new Map<string, Promise<void>>();

  reserve(scope: ResponseExecutionScope, recover: Recover): Promise<ResponseScopeReservation> {
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recover(entry, recover);
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

  ensureHolder(scope: ResponseExecutionScope, expected: ActiveResponseReference, recover: Recover): Promise<void> {
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recover(entry, recover);
      const existing = entry.holders.get(expected.sessionId);
      if (existing?.responseId === expected.responseId) return;
      this.assertAvailable(scope, entry);
      entry.holders.set(expected.sessionId, structuredClone(expected));
    });
  }

  release(scope: ResponseExecutionScope, holder: ActiveResponseReference): Promise<void> {
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.holders.get(holder.sessionId)?.responseId === holder.responseId) entry.holders.delete(holder.sessionId);
      this.prune(scope.key, entry);
    });
  }

  async withMaintenance<T>(scope: ResponseExecutionScope, operation: () => Promise<T>): Promise<T> {
    await this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.reservations.size || entry.maintenanceCount) throw new ResponseScopeConflictError(scope);
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

  private async recover(entry: ScopeEntry, recover: Recover): Promise<void> {
    for (const holder of await recover()) if (!entry.holders.has(holder.sessionId)) entry.holders.set(holder.sessionId, holder);
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
