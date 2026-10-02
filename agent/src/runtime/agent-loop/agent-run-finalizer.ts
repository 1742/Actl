import type { Logger } from "../../observability/logger.js";
import { errorFields } from "../../observability/logger.js";
import { nowIso } from "../../utils.js";
import type { AgentDomainEvent, AgentDomainEventHandler, AgentRunRecord } from "../agent-domain.js";
import type { ToolBatchExecutor } from "./tool-batch-executor.js";
import { type Session, WorkspaceStore } from "../workspace-store.js";

export class AgentRunFinalizer {
  constructor(
    private readonly workspaceStore: WorkspaceStore,
    private readonly toolExecutor: ToolBatchExecutor,
    private readonly logger: Logger,
  ) {}

  async completed(session: Session, run: AgentRunRecord, onEvent?: AgentDomainEventHandler): Promise<AgentRunRecord> {
    run.status = "completed";
    run.completedAt = nowIso();
    await this.persistAndEmit(session, run, { type: "run_completed", run }, onEvent);
    return run;
  }

  async incomplete(session: Session, run: AgentRunRecord, onEvent?: AgentDomainEventHandler): Promise<AgentRunRecord> {
    run.status = "incomplete";
    run.completedAt = nowIso();
    await this.persistAndEmit(session, run, { type: "run_incomplete", run }, onEvent);
    return run;
  }

  async cancelled(session: Session, run: AgentRunRecord, onEvent?: AgentDomainEventHandler): Promise<AgentRunRecord> {
    if (run.status === "cancelled") return run;
    if (run.status === "waiting_permission") run.status = "in_progress";
    await this.toolExecutor.closeOutstanding(
      session,
      run,
      "Agent response was cancelled.",
      "Tool call was cancelled before it completed.",
      onEvent,
    );
    run.status = "cancelled";
    delete run.error;
    run.completedAt = nowIso();
    await this.persistAndEmit(session, run, { type: "run_cancelled", run }, onEvent);
    this.logger.info({ event: "agent.response.cancelled", ...logFields(session, run) });
    return run;
  }

  async failed(
    session: Session,
    run: AgentRunRecord,
    error: unknown,
    onEvent?: AgentDomainEventHandler,
  ): Promise<AgentRunRecord> {
    if (run.status === "waiting_permission") run.status = "in_progress";
    await this.toolExecutor.closeOutstanding(
      session,
      run,
      "Agent response ended unexpectedly.",
      "Tool call was not run because the agent response ended unexpectedly.",
      onEvent,
    );
    run.status = "failed";
    run.error = { code: "agent_run_failed", message: error instanceof Error ? error.message : String(error) };
    run.completedAt = nowIso();
    await this.persistAndEmit(session, run, { type: "run_failed", run }, onEvent);
    this.logger.error({
      event: "agent.response.failed",
      ...logFields(session, run),
      errorCode: run.error.code,
      ...errorFields(error),
    });
    return run;
  }

  private async persistAndEmit(
    session: Session,
    run: AgentRunRecord,
    event: AgentDomainEvent,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    await this.workspaceStore.touch(session, run);
    if (onEvent) await onEvent(run, structuredClone(event));
  }
}

function logFields(session: Session, run: AgentRunRecord): Record<string, string> {
  return { sessionId: session.id, responseId: run.id, model: run.modelSnapshot.targetId, ...(session.projectId ? { projectId: session.projectId } : {}) };
}
