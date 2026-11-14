import type { HookEventBus } from "../../hooks/event-bus.js";
import type { ReasoningEffort } from "../../model/catalog-types.js";
import type { TranscriptMessage } from "../../model/types.js";
import type { Logger } from "../../observability/logger.js";
import type { PermissionEngine, PermissionMode } from "../../permissions/engine.js";
import type { AgentCoordinationRepository } from "../../repositories/agent-coordination-repository.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { isTerminalRun, type AgentDomainEventHandler, type AgentRunRecord, type PendingToolBatch, type PermissionResolution } from "../agent-domain.js";
import { AgentLoop } from "../agent-loop/agent-loop.js";
import { AgentLoopError } from "../agent-loop/agent-loop-error.js";
import { ExecutionAdmission, ResponseScopeConflictError, activeResponseReference } from "../execution-admission.js";
import type { SessionProcessScope } from "../process/process-types.js";
import type { Session, WorkspaceStore } from "../workspace-store.js";
import { SessionModelContext, type SessionContextServices } from "./session-model-context.js";
import { SessionTools } from "./session-tools.js";

export interface AgentRunOptions {
  model: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode: PermissionMode;
}

export type PrepareRunInput = (signal: AbortSignal) => Promise<TranscriptMessage[]>;

export interface SessionRuntimeServices extends SessionContextServices {
  toolRegistry: ToolRegistry;
  permissions: PermissionEngine;
  hooks: HookEventBus;
  logger: Logger;
}

interface SessionOperation {
  readonly controller: AbortController;
  readonly done: Promise<unknown>;
  preparing: boolean;
}

export class SessionRuntime {
  private readonly loop: AgentLoop;
  private readonly context: SessionModelContext;
  private active: SessionOperation | undefined;
  private stopping: Promise<void> | undefined;

  constructor(
    readonly session: Session,
    private readonly workspace: WorkspaceStore,
    inbox: AgentCoordinationRepository,
    private readonly admission: ExecutionAdmission,
    private readonly processes: SessionProcessScope,
    private readonly services: SessionRuntimeServices,
    private readonly onEvent: AgentDomainEventHandler,
  ) {
    const tools = new SessionTools(session, services.toolRegistry, workspace, processes, services.logger);
    this.context = new SessionModelContext(session, workspace, inbox, services, tools);
    this.loop = new AgentLoop(this.context, services.models, services.hooks, workspace, services.logger, tools, services.permissions);
  }

  get preparing(): boolean { return this.active?.preparing ?? false; }
  get executing(): boolean { return this.active?.preparing === false; }

  start(
    prepareInput: PrepareRunInput,
    options: AgentRunOptions,
    onEvent: AgentDomainEventHandler,
  ): Promise<AgentRunRecord> {
    return this.operate(async (operation) => {
      const session = this.session;
      const { signal } = operation.controller;
      const reservation = await this.admission.reserve(session);
      let run: AgentRunRecord;
      try {
        signal.throwIfAborted();
        const snapshot = await this.services.models.resolveSnapshot(session.ownerId, options.model, options.reasoningEffort);
        signal.throwIfAborted();
        const input = await prepareInput(signal);
        signal.throwIfAborted();
        const prepared = await this.context.prepareInput(input, snapshot, signal);
        signal.throwIfAborted();
        run = await this.workspace.createResponse(session, prepared, snapshot, {
          permissionMode: session.parentSessionId ? "plan" : options.permissionMode,
        });
        this.admission.activate(reservation, activeResponseReference(run, session));
      } catch (error) {
        await this.admission.releaseReservation(reservation);
        throw error;
      }
      operation.preparing = false;
      return this.execute(run, async () => {
        this.services.logger.info({
          event: "agent.response.created", sessionId: session.id, responseId: run.id,
          model: run.modelSnapshot.targetId, inputItemCount: run.input.length,
          ...(session.projectId ? { projectId: session.projectId } : {}),
        });
        try { await onEvent(run, { type: "run_created", run }); }
        catch (error) { return this.loop.fail(run, error, onEvent); }
        return this.loop.execute(run, signal, onEvent);
      });
    });
  }

  resume(
    run: AgentRunRecord,
    batchId: string,
    decisions: readonly PermissionResolution[],
    onEvent: AgentDomainEventHandler,
  ): Promise<AgentRunRecord> {
    return this.operate(async (operation) => {
      this.assertPermissionBatch(run, batchId, decisions);
      await this.admission.ensureHolder(this.session, run);
      operation.controller.signal.throwIfAborted();
      this.assertPermissionBatch(run, batchId, decisions);
      operation.preparing = false;
      return this.execute(run, () => this.loop.execute(run, operation.controller.signal, onEvent, decisions));
    });
  }

  compact(model: string, reasoningEffort?: ReasoningEffort): Promise<boolean> {
    return this.operate(({ controller: { signal } }) => this.admission.withIdleSessionMaintenance(this.session.id, () => {
      signal.throwIfAborted();
      return this.context.compact(model, reasoningEffort, signal);
    }));
  }

  stop(keepApprovals = false): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.active;
    active?.controller.abort(new DOMException("Agent response was cancelled.", "AbortError"));
    const stopping = Promise.resolve().then(async () => {
      // Preparation and execution share one signal and one completion promise.
      // Wait for both persistence and admission cleanup before finalizing suspended runs.
      if (active) await Promise.allSettled([active.done]);
      try {
        for (const run of this.session.runs) {
          if (run.status !== "in_progress" && (keepApprovals || run.status !== "waiting_permission")) continue;
          await this.admission.ensureHolder(this.session, run);
          await this.execute(run, () => this.loop.cancel(run, this.onEvent));
        }
      } finally {
        if (!keepApprovals) await this.processes.stopAll();
      }
    }).finally(() => { this.stopping = undefined; });
    this.stopping = stopping;
    return stopping;
  }

  private operate<T>(work: (operation: SessionOperation) => Promise<T>): Promise<T> {
    if (this.active || this.stopping) {
      const run = this.session.runs.find((item) => !isTerminalRun(item));
      return Promise.reject(new AgentLoopError("active_response_exists", "Session already has an active response or maintenance operation.",
        run && { sessionId: this.session.id, responseId: run.id }));
    }
    const controller = new AbortController();
    const done = Promise.resolve().then(() => work(operation)).catch((error: unknown) => {
      throw mapSessionConcurrencyError(this.session, error);
    }).finally(() => { this.active = undefined; });
    const operation: SessionOperation = { controller, done, preparing: true };
    this.active = operation;
    return done;
  }

  private async execute(run: AgentRunRecord, work: () => Promise<AgentRunRecord>): Promise<AgentRunRecord> {
    try {
      const result = await work();
      // A suspended approval still owns admission, but no execution promise or controller.
      if (isTerminalRun(result)) await this.admission.release(this.session, result);
      return result;
    } catch (error) {
      await this.admission.release(this.session, run);
      throw error;
    }
  }

  private assertPermissionBatch(run: AgentRunRecord, batchId: string, decisions: readonly PermissionResolution[]): void {
    if (run.status !== "waiting_permission" || !run.pendingToolBatch) {
      throw new AgentLoopError("permission_batch_not_pending", "Response has no pending permission batch.");
    }
    if (run.pendingToolBatch.id !== batchId) {
      throw new AgentLoopError("permission_batch_not_current", "Permission batch is not the current pending batch.");
    }
    validatePermissionDecisions(run.pendingToolBatch, decisions);
  }
}

function validatePermissionDecisions(batch: PendingToolBatch, decisions: readonly PermissionResolution[]): void {
  const expectedIds = new Set(batch.permissions.map((permission) => permission.id));
  const decisionsById = new Set<string>();
  for (const decision of decisions) {
    if (decisionsById.has(decision.permissionId) || !expectedIds.has(decision.permissionId)) {
      throw new AgentLoopError("permission_batch_decisions_invalid", "Permission decisions contain duplicate or unknown permission IDs.");
    }
    decisionsById.add(decision.permissionId);
  }
  if (decisionsById.size !== expectedIds.size) {
    throw new AgentLoopError("permission_batch_decisions_invalid", "Permission decisions must resolve every permission in the current batch.");
  }
}

export function mapSessionConcurrencyError(session: Session, error: unknown): unknown {
  if (!(error instanceof ResponseScopeConflictError)) return error;
  const details = error.holder && { sessionId: error.holder.sessionId, responseId: error.holder.responseId };
  if (error.scope.type === "project" && error.holder?.sessionId !== session.id) {
    return new AgentLoopError("project_active_response_exists", "Project already has an active response.", details);
  }
  return new AgentLoopError("active_response_exists", "Session already has an active response.", details);
}
