import type { HookEventBus } from "../../hooks/event-bus.js";
import type { ModelTurnEvent, TranscriptItem, TranscriptMessage } from "../../model/types.js";
import { errorFields, type Logger } from "../../observability/logger.js";
import type { PermissionEngine } from "../../permissions/engine.js";
import { createRandomId } from "../../utils.js";
import {
  type AgentDomainEvent,
  type AgentDomainEventHandler,
  type AgentRunRecord,
  type AgentTimelineItem,
  findUnresolvedToolCalls,
  type PermissionRequestItem,
  type PermissionResolution,
} from "../agent-domain.js";
import type { ModelStore } from "../model-store.js";
import type { SessionModelContext } from "../session/session-model-context.js";
import type { SessionTools } from "../session/session-tools.js";
import type { Session, WorkspaceStore } from "../workspace-store.js";
import { AgentRunFinalizer } from "./agent-run-finalizer.js";
import { ToolBatchExecutor } from "./tool-batch-executor.js";

export class AgentLoop {
  private readonly toolExecutor: ToolBatchExecutor;
  private readonly finalizer: AgentRunFinalizer;

  constructor(
    private readonly context: SessionModelContext,
    private readonly modelClientRouter: ModelStore,
    private readonly hookEventBus: HookEventBus,
    private readonly workspaceStore: WorkspaceStore,
    private readonly logger: Logger,
    tools: SessionTools,
    permissions: PermissionEngine,
  ) {
    this.toolExecutor = new ToolBatchExecutor(tools, permissions, hookEventBus, workspaceStore, logger);
    this.finalizer = new AgentRunFinalizer(workspaceStore, this.toolExecutor, logger);
  }

  cancel(run: AgentRunRecord, onEvent: AgentDomainEventHandler): Promise<AgentRunRecord> {
    return this.finalizer.cancelled(this.context.session, run, onEvent);
  }

  fail(run: AgentRunRecord, error: unknown, onEvent: AgentDomainEventHandler): Promise<AgentRunRecord> {
    return this.finalizer.failed(this.context.session, run, error, onEvent);
  }

  async execute(
    run: AgentRunRecord,
    signal: AbortSignal,
    onEvent: AgentDomainEventHandler,
    decisions?: readonly PermissionResolution[],
  ): Promise<AgentRunRecord> {
    const session = this.context.session;
    try {
      signal.throwIfAborted();
      if (decisions) await this.toolExecutor.resolvePermissions(session, run, decisions, signal, onEvent);
      const references = await this.context.resolveReferences(run);
      for (let step = 0; step < 100; step += 1) {
        signal.throwIfAborted();
        const unresolvedToolCalls = findUnresolvedToolCalls(run.timeline);
        if (unresolvedToolCalls.length > 0) {
          const waiting = await this.toolExecutor.process(session, run, unresolvedToolCalls, signal, onEvent);
          if (waiting) return run;
          continue;
        }

        const { prompt, tools, search, nativeWebSearch } = await this.context.prepareModelStep(run, references, signal, onEvent);
        signal.throwIfAborted();
        const itemIndexes = new Map<string, number>();
        const startedAt = performance.now();
        let invocation;
        try {
          const modelClient = await this.modelClientRouter.getClientForSnapshot(session.ownerId, run.modelSnapshot);
          invocation = await modelClient.runTurn({
            model: run.modelSnapshot.providerModel,
            instructions: prompt.instructions,
            transcript: prompt.transcript,
            tools,
            ...(nativeWebSearch ? { nativeWebSearch: true } : {}),
            parallelToolCalls: run.modelSnapshot.capabilities.parallelToolCalls,
            ...(run.modelSnapshot.capabilities.maxOutputTokens ? { maxOutputTokens: run.modelSnapshot.capabilities.maxOutputTokens } : {}),
            ...(run.modelSnapshot.reasoningEffort ? { reasoningEffort: run.modelSnapshot.reasoningEffort } : {}),
          }, (event) => {
            signal.throwIfAborted();
            return this.consumeModelEvent(session, run, itemIndexes, event, onEvent);
          }, { signal });
          signal.throwIfAborted();
          this.logger.info({
            event: "agent.model.completed", ...logFields(session, run), step,
            ...(invocation.providerRequestId ? { providerResponseId: invocation.providerRequestId } : {}),
            inputItemCount: prompt.transcript.length, toolCount: tools.length,
            webSearchStrategy: search?.kind ?? "external",
            webSearchProvider: search ? ("provider" in search ? search.provider : search.reason) : "brave",
            durationMs: Math.round(performance.now() - startedAt),
          });
        } catch (error) {
          if (!signal.aborted) {
            this.logger.error({ event: "agent.model.failed", ...logFields(session, run), step, durationMs: Math.round(performance.now() - startedAt), ...errorFields(error) });
          }
          throw error;
        }

        if (invocation.providerRequestId) await this.workspaceStore.recordProviderResponseId(run.id, invocation.providerRequestId);
        if (invocation.usage) await this.workspaceStore.recordModelUsage(session, run.id, step, invocation.usage);
        await this.ensureInvocationItems(session, run, itemIndexes, invocation.output, onEvent);
        signal.throwIfAborted();
        if (invocation.finishReason === "unknown") throw new Error("Model stream ended without a recognized finish reason.");
        if (invocation.finishReason === "length" || invocation.finishReason === "content_filter") {
          return this.finalizer.incomplete(session, run, onEvent);
        }

        const functionCalls = invocation.output.filter(
          (item): item is Extract<TranscriptItem, { type: "tool_call" }> => item.type === "tool_call",
        );
        if (functionCalls.length > 0) {
          const waiting = await this.toolExecutor.process(session, run, functionCalls, signal, onEvent);
          if (waiting) return run;
          continue;
        }

        const message = [...invocation.output].reverse().find(
          (item): item is Extract<TranscriptItem, { type: "message" }> => item.type === "message" && item.role === "assistant",
        );
        const text = message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
        const stopDecision = await this.hookEventBus.emit("Stop", { session, response: text });
        signal.throwIfAborted();
        if (stopDecision.blocked) {
          await this.addSyntheticMessage(session, run, stopDecision.reason ?? "Stop was blocked by a runtime hook.", onEvent);
          continue;
        }

        // Check the inbox for messages; if any are found, inject them into the user message in the next round.
        if (!this.context.readyToComplete()) continue;
        
        return this.finalizer.completed(session, run, onEvent);
      }
      throw new Error("Agent loop exceeded maximum steps.");
    } catch (error) {
      if (signal.aborted) return this.finalizer.cancelled(session, run, onEvent);
      return this.finalizer.failed(session, run, error, onEvent);
    }
  }

  private async consumeModelEvent(
    session: Session,
    run: AgentRunRecord,
    itemIndexes: Map<string, number>,
    event: ModelTurnEvent,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    if (event.type === "usage") return;
    if (event.type === "output_item_started") {
      const item = createStreamingItem(event.item);
      const outputIndex = run.timeline.push(item) - 1;
      itemIndexes.set(event.item.id, outputIndex);
      await emit(onEvent, run, { type: "item_started", item, outputIndex });
      return;
    }
    const eventItemId = event.type === "output_item_completed" ? event.item.id : event.itemId;
    const outputIndex = itemIndexes.get(eventItemId);
    if (outputIndex === undefined) return;
    const item = run.timeline[outputIndex];
    if (event.type === "text_delta" && item?.type === "message") {
      const existing = item.content[event.contentIndex];
      if (existing?.type === "text") existing.text += event.delta;
      else item.content[event.contentIndex] = { type: "text", text: event.delta };
      await emit(onEvent, run, { type: "text_delta", itemId: event.itemId, outputIndex, contentIndex: event.contentIndex, delta: event.delta });
    } else if (event.type === "reasoning_delta" && item?.type === "reasoning") {
      const parts = event.section === "summary" ? item.summary : item.content;
      const existing = parts[event.contentIndex];
      if (existing?.type === "text") existing.text += event.delta;
      else parts[event.contentIndex] = { type: "text", text: event.delta };
      await emit(onEvent, run, { type: "reasoning_delta", itemId: event.itemId, outputIndex, section: event.section, contentIndex: event.contentIndex, delta: event.delta });
    } else if (event.type === "tool_call_delta" && item?.type === "tool_call") {
      item.argumentsJson += event.argumentsDelta ?? "";
      if (event.name) item.name = event.name;
      await emit(onEvent, run, { type: "tool_arguments_delta", itemId: event.itemId, outputIndex, delta: event.argumentsDelta ?? "" });
    } else if (event.type === "output_item_completed") {
      run.timeline[outputIndex] = structuredClone(event.item);
      await emit(onEvent, run, { type: "item_completed", item: event.item, outputIndex });
      await this.workspaceStore.touch(session, run);
    }
  }

  private async ensureInvocationItems(
    session: Session,
    run: AgentRunRecord,
    itemIndexes: Map<string, number>,
    output: TranscriptItem[],
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    for (const item of output) {
      if (itemIndexes.has(item.id)) continue;
      const outputIndex = run.timeline.push(structuredClone(item)) - 1;
      itemIndexes.set(item.id, outputIndex);
      await emit(onEvent, run, { type: "item_started", item, outputIndex });
      await emit(onEvent, run, { type: "item_completed", item, outputIndex });
      await this.workspaceStore.touch(session, run);
    }
  }

  private async addSyntheticMessage(session: Session, run: AgentRunRecord, text: string, onEvent?: AgentDomainEventHandler): Promise<void> {
    const item: TranscriptMessage = { id: createRandomId("msg"), type: "message", role: "assistant", content: [{ type: "text", text }] };
    const outputIndex = run.timeline.push(item) - 1;
    await this.workspaceStore.touch(session, run);
    await emit(onEvent, run, { type: "item_started", item: { ...item, content: [] }, outputIndex });
    await emit(onEvent, run, { type: "text_delta", itemId: item.id, outputIndex, contentIndex: 0, delta: text });
    await emit(onEvent, run, { type: "item_completed", item, outputIndex });
  }
}

function createStreamingItem(item: Exclude<TranscriptItem, { type: "tool_result" }>): Exclude<AgentTimelineItem, PermissionRequestItem | Extract<TranscriptItem, { type: "tool_result" }>> {
  if (item.type === "message") return { ...structuredClone(item), content: [] };
  if (item.type === "reasoning") return { ...structuredClone(item), summary: [], content: [] };
  if (item.type === "web_search") return structuredClone(item);
  return { ...structuredClone(item), argumentsJson: "" };
}

function logFields(session: Session, run: AgentRunRecord): Record<string, string> {
  return { sessionId: session.id, responseId: run.id, model: run.modelSnapshot.targetId, ...(session.projectId ? { projectId: session.projectId } : {}) };
}

async function emit(handler: AgentDomainEventHandler | undefined, run: AgentRunRecord, event: AgentDomainEvent): Promise<void> {
  if (handler) await handler(run, structuredClone(event));
}
