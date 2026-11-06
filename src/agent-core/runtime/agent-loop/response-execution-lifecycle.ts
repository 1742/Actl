import type { AgentRunRecord } from "../agent-domain.js";
import type { Session, WorkspaceStore } from "../workspace-store.js";
import { RunExecutionManager, type RunExecutionContext } from "./run-execution-manager.js";
import {
  activeResponseReference,
  executionScopeForSession,
  ResponseConcurrencyCoordinator,
  ResponseScopeConflictError,
  type ResponseExecutionScope,
} from "./response-concurrency-coordinator.js";

export interface ActiveResponseExecution {
  readonly session: Session;
  readonly run: AgentRunRecord;
  readonly context: RunExecutionContext;
  readonly scope: ResponseExecutionScope;
}

export class ResponseExecutionLifecycle {
  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly executions = new RunExecutionManager(),
    private readonly concurrency = new ResponseConcurrencyCoordinator(),
  ) {}

  async create(
    session: Session,
    createResponse: () => Promise<AgentRunRecord>,
  ): Promise<ActiveResponseExecution> {
    const scope = executionScopeForSession(session);
    const reservation = await this.concurrency.reserve(scope, () => this.recoverActiveResponse(session));
    try {
      const run = await createResponse();
      this.concurrency.activate(reservation, activeResponseReference(run));
      return this.execution(session, run, scope);
    } catch (error) {
      await this.concurrency.releaseReservation(reservation);
      throw error;
    }
  }

  async attach(session: Session, run: AgentRunRecord): Promise<ActiveResponseExecution> {
    const scope = executionScopeForSession(session);
    await this.concurrency.ensureHolder(
      scope,
      activeResponseReference(run),
      () => this.recoverActiveResponse(session),
    );
    return this.execution(session, run, scope);
  }

  track(
    execution: ActiveResponseExecution,
    running: Promise<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    return this.executions.track(
      execution.context,
      this.releaseAfterTerminal(execution, running),
    );
  }

  async finish(
    execution: ActiveResponseExecution,
    finalization: Promise<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    try {
      return await finalization;
    } finally {
      await this.release(execution);
    }
  }

  async cancel(
    execution: ActiveResponseExecution,
    finalize: () => Promise<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    const run = await this.executions.cancel(execution.context, finalize);
    await this.releaseIfTerminal(execution.scope, run);
    return run;
  }

  sessionIds(): string[] {
    return this.executions.sessionIds();
  }

  async withSessionMaintenance<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const session = await this.workspaceStore.getSession(sessionId);
    return this.concurrency.withMaintenance(
      session
        ? executionScopeForSession(session)
        : { key: `session:${sessionId}`, type: "session", id: sessionId },
      operation,
    );
  }

  async withIdleSessionMaintenance<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const session = await this.workspaceStore.getSession(sessionId);
    const scope = session
      ? executionScopeForSession(session)
      : { key: `session:${sessionId}`, type: "session" as const, id: sessionId };
    return this.concurrency.withMaintenance(scope, async () => {
      if (session) {
        const active = await this.workspaceStore.findActiveResponseInScope(session);
        if (active) {
          throw new ResponseScopeConflictError(scope, activeResponseReference(active));
        }
      }
      return operation();
    });
  }

  withProjectMaintenance<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.concurrency.withMaintenance(
      { key: `project:${projectId}`, type: "project", id: projectId },
      operation,
    );
  }

  private execution(
    session: Session,
    run: AgentRunRecord,
    scope: ResponseExecutionScope,
  ): ActiveResponseExecution {
    return {
      session,
      run,
      scope,
      context: this.executions.ensure(session.id, run.id),
    };
  }

  private async recoverActiveResponse(session: Session) {
    const active = session.projectId === null
      ? this.workspaceStore.listResponses(session.id)
        .find((run) => run.status === "in_progress" || run.status === "waiting_permission")
      : await this.workspaceStore.findActiveResponseInScope(session);
    return active ? activeResponseReference(active) : undefined;
  }

  private async releaseAfterTerminal(
    execution: ActiveResponseExecution,
    running: Promise<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    try {
      const run = await running;
      await this.releaseIfTerminal(execution.scope, run);
      return run;
    } catch (error) {
      await this.release(execution);
      throw error;
    }
  }

  private release(execution: ActiveResponseExecution): Promise<void> {
    return this.concurrency.release(execution.scope, activeResponseReference(execution.run));
  }

  private async releaseIfTerminal(scope: ResponseExecutionScope, run: AgentRunRecord): Promise<void> {
    if (run.status === "completed" || run.status === "incomplete" || run.status === "failed" || run.status === "cancelled") {
      await this.concurrency.release(scope, activeResponseReference(run));
    }
  }
}
