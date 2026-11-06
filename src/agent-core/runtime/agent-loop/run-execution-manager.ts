import type { AgentRunRecord } from "../agent-domain.js";

export interface RunExecutionContext {
  readonly sessionId: string;
  readonly responseId: string;
  readonly controller: AbortController;
  execution?: Promise<AgentRunRecord>;
  cancellation?: Promise<AgentRunRecord>;
}

export class RunExecutionManager {
  private readonly contexts = new Map<string, RunExecutionContext>();

  ensure(sessionId: string, responseId: string): RunExecutionContext {
    let context = this.contexts.get(responseId);
    if (!context) {
      context = { sessionId, responseId, controller: new AbortController() };
      this.contexts.set(responseId, context);
    }
    return context;
  }

  track(context: RunExecutionContext, execution: Promise<AgentRunRecord>): Promise<AgentRunRecord> {
    context.execution = execution;
    void execution.then((run) => {
      if (isTerminalRun(run)) this.release(context.responseId);
    }).finally(() => {
      if (context.execution === execution) delete context.execution;
    }).catch(() => undefined);
    return execution;
  }

  cancel(
    context: RunExecutionContext,
    finalize: () => Promise<AgentRunRecord>,
  ): Promise<AgentRunRecord> {
    if (context.cancellation) return context.cancellation;
    context.controller.abort(new DOMException("Agent response was cancelled.", "AbortError"));
    const cancellation = context.execution ? context.execution.then(() => finalize()) : finalize();
    context.cancellation = cancellation.finally(() => this.release(context.responseId));
    return context.cancellation;
  }

  sessionIds(): string[] {
    return [...new Set([...this.contexts.values()].map((context) => context.sessionId))];
  }

  release(responseId: string): void {
    this.contexts.delete(responseId);
  }
}

function isTerminalRun(run: AgentRunRecord): boolean {
  return run.status === "completed" || run.status === "incomplete" || run.status === "failed" || run.status === "cancelled";
}
