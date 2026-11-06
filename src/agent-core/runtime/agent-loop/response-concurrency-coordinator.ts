import type { AgentRunRecord } from "../agent-domain.js";
import type { Session } from "../workspace-store.js";

export interface ActiveResponseReference {
  sessionId: string;
  responseId: string;
}

export interface ResponseExecutionScope {
  key: string;
  type: "project" | "session";
  id: string;
}

interface ScopeEntry {
  holder?: ActiveResponseReference;
  reservation?: symbol;
  maintenanceCount: number;
}

export interface ResponseScopeReservation {
  readonly scope: ResponseExecutionScope;
  readonly token: symbol;
}

export class ResponseScopeConflictError extends Error {
  constructor(
    readonly scope: ResponseExecutionScope,
    readonly holder?: ActiveResponseReference,
  ) {
    super(holder
      ? `Response execution scope is occupied by ${holder.responseId}.`
      : "Response execution scope is temporarily unavailable.");
  }
}

export class ResponseConcurrencyCoordinator {
  private readonly entries = new Map<string, ScopeEntry>();
  private readonly queues = new Map<string, Promise<void>>();

  async reserve(
    scope: ResponseExecutionScope,
    recover: () => Promise<ActiveResponseReference | undefined>,
  ): Promise<ResponseScopeReservation> {
    return this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recoverHolder(entry, recover);
      if (entry.holder || entry.reservation || entry.maintenanceCount > 0) {
        throw new ResponseScopeConflictError(scope, entry.holder);
      }
      const token = Symbol(scope.key);
      entry.reservation = token;
      return { scope, token };
    });
  }

  activate(reservation: ResponseScopeReservation, holder: ActiveResponseReference): void {
    const entry = this.entry(reservation.scope.key);
    if (entry.reservation !== reservation.token) {
      throw new Error("Response execution scope reservation is no longer current.");
    }
    delete entry.reservation;
    entry.holder = structuredClone(holder);
  }

  async releaseReservation(reservation: ResponseScopeReservation): Promise<void> {
    await this.serialized(reservation.scope.key, async () => {
      const entry = this.entry(reservation.scope.key);
      if (entry.reservation === reservation.token) delete entry.reservation;
      this.deleteIfEmpty(reservation.scope.key, entry);
    });
  }

  async ensureHolder(
    scope: ResponseExecutionScope,
    expected: ActiveResponseReference,
    recover: () => Promise<ActiveResponseReference | undefined>,
  ): Promise<void> {
    await this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      await this.recoverHolder(entry, recover);
      if (!entry.holder) {
        entry.holder = structuredClone(expected);
        return;
      }
      if (!sameHolder(entry.holder, expected)) {
        throw new ResponseScopeConflictError(scope, entry.holder);
      }
    });
  }

  async release(scope: ResponseExecutionScope, holder: ActiveResponseReference): Promise<void> {
    await this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.holder && sameHolder(entry.holder, holder)) delete entry.holder;
      this.deleteIfEmpty(scope.key, entry);
    });
  }

  async withMaintenance<T>(scope: ResponseExecutionScope, operation: () => Promise<T>): Promise<T> {
    await this.serialized(scope.key, async () => {
      const entry = this.entry(scope.key);
      if (entry.reservation) throw new ResponseScopeConflictError(scope, entry.holder);
      entry.maintenanceCount += 1;
    });
    try {
      return await operation();
    } finally {
      await this.serialized(scope.key, async () => {
        const entry = this.entry(scope.key);
        entry.maintenanceCount = Math.max(0, entry.maintenanceCount - 1);
        this.deleteIfEmpty(scope.key, entry);
      });
    }
  }

  private async recoverHolder(
    entry: ScopeEntry,
    recover: () => Promise<ActiveResponseReference | undefined>,
  ): Promise<void> {
    if (entry.holder || entry.reservation) return;
    const recovered = await recover();
    if (recovered) entry.holder = structuredClone(recovered);
  }

  private entry(key: string): ScopeEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { maintenanceCount: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private deleteIfEmpty(key: string, entry: ScopeEntry): void {
    if (!entry.holder && !entry.reservation && entry.maintenanceCount === 0) {
      this.entries.delete(key);
    }
  }

  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.finally(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }
}

export function executionScopeForSession(session: Session): ResponseExecutionScope {
  return session.projectId
    ? { key: `project:${session.projectId}`, type: "project", id: session.projectId }
    : { key: `session:${session.id}`, type: "session", id: session.id };
}

export function activeResponseReference(run: AgentRunRecord): ActiveResponseReference {
  return { sessionId: run.sessionId, responseId: run.id };
}

function sameHolder(left: ActiveResponseReference, right: ActiveResponseReference): boolean {
  return left.sessionId === right.sessionId && left.responseId === right.responseId;
}
