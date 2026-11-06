import type { HookEventBus } from "../../hooks/event-bus.js";
import type { TranscriptItem } from "../../model/types.js";
import type { Logger } from "../../observability/logger.js";
import type { PermissionEngine } from "../../permissions/engine.js";
import type { ToolCallContext, ToolExecutionPolicy, ToolPermissionRequirement, ToolRegistry } from "../../tools/registry.js";
import { createRandomId, nowIso } from "../../utils.js";
import {
  type AgentDomainEvent,
  type AgentDomainEventHandler,
  type AgentRunRecord,
  type PendingPermission,
  type PendingToolBatch,
  type PendingToolBatchItem,
  type PermissionRequestItem,
  type PermissionResolution,
} from "../agent-domain.js";
import type { ToolCall, ToolResult } from "../transcript.js";
import { type Session, WorkspaceStore } from "../workspace-store.js";

type ToolCallBatchOutcome =
  | { kind: "result"; toolCall: ToolCall; result: ToolResult; emitPostToolUse: boolean; permission?: ToolExecutionPermission }
  | {
      kind: "execute";
      toolCall: ToolCall;
      requirement: ToolPermissionRequirement;
      approvedByUser: boolean;
      execution: ToolExecutionPolicy;
    };

const MAX_PARALLEL_TOOL_CALLS = 4;

type ToolExecutionPermission = "automatic" | "user_approved" | "user_denied" | "policy_denied";

export class ToolBatchExecutor {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly permissionEngine: PermissionEngine,
    private readonly hookEventBus: HookEventBus,
    private readonly workspaceStore: WorkspaceStore,
    private readonly logger: Logger,
  ) {}

  async process(
    session: Session,
    run: AgentRunRecord,
    functionCalls: readonly Extract<TranscriptItem, { type: "tool_call" }>[],
    signal: AbortSignal,
    onEvent?: AgentDomainEventHandler,
  ): Promise<boolean> {
    const preparedItems: PendingToolBatchItem[] = [];
    let hasPermissionRequests = false;
    const availableTools = new Set((await this.toolRegistry.listTools(run.modelSnapshot.capabilities)).map((tool) => tool.name));

    for (const functionCall of functionCalls) {
      signal.throwIfAborted();
      const unvalidatedToolCall: ToolCall = {
        id: functionCall.callId,
        name: functionCall.name,
        input: parseArguments(functionCall.argumentsJson),
      };
      const prepared = await this.toolRegistry.prepareToolCall(unvalidatedToolCall);
      if (!prepared.ok) {
        preparedItems.push({ kind: "result", toolCall: unvalidatedToolCall, result: prepared.result, emitPostToolUse: false });
        continue;
      }

      const toolCall = prepared.toolCall;
      if (!availableTools.has(toolCall.name)) {
        preparedItems.push({ kind: "result", toolCall, emitPostToolUse: false, result: {
          toolCallId: toolCall.id, toolName: toolCall.name, ok: false,
          error: `Tool ${toolCall.name} is unavailable for the current model. Switch to a model supporting its required input capabilities.`,
        } });
        continue;
      }
      const preToolUseDecision = await this.hookEventBus.emit("PreToolUse", { session, toolCall });
      signal.throwIfAborted();
      if (preToolUseDecision.blocked) {
        preparedItems.push({
          kind: "result",
          toolCall,
          result: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ok: false,
            error: preToolUseDecision.reason ?? "Tool call was blocked by a runtime hook.",
          },
          emitPostToolUse: false,
          permission: "policy_denied",
        });
        continue;
      }

      let requirement: ToolPermissionRequirement | null;
      try {
        requirement = await this.toolRegistry.getPermissionRequirement(toolCall, {
          cwd: session.cwd,
          sessionId: session.id,
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        preparedItems.push({
          kind: "result",
          toolCall,
          result: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          emitPostToolUse: false,
          permission: "policy_denied",
        });
        continue;
      }
      signal.throwIfAborted();
      if (!requirement) {
        preparedItems.push({
          kind: "result",
          toolCall,
          result: { toolCallId: toolCall.id, toolName: toolCall.name, ok: false, error: `Unknown tool: ${toolCall.name}` },
          emitPostToolUse: false,
          permission: "policy_denied",
        });
        continue;
      }

      const permissionDecision = await this.permissionEngine.decide(toolCall, requirement, {
        snapshot: run.permissionSnapshot,
      });
      signal.throwIfAborted();
      if (permissionDecision.type === "ask") {
        hasPermissionRequests = true;
        preparedItems.push({
          kind: "permission",
          permissionId: createRandomId("permission"),
          toolCall,
          requirement,
          execution: await this.toolRegistry.getExecutionPolicy(toolCall),
          prompt: permissionDecision.prompt,
        });
      } else if (permissionDecision.type === "deny") {
        preparedItems.push({
          kind: "result",
          toolCall,
          result: { toolCallId: toolCall.id, toolName: toolCall.name, ok: false, error: permissionDecision.reason },
          emitPostToolUse: false,
          permission: "policy_denied",
        });
      } else {
        preparedItems.push({
          kind: "execute",
          toolCall,
          requirement,
          execution: await this.toolRegistry.getExecutionPolicy(toolCall),
        });
      }
    }

    if (hasPermissionRequests) {
      signal.throwIfAborted();
      await this.requestPermissions(session, run, preparedItems, onEvent);
      return true;
    }
    await this.completeBatch(session, run, preparedItems.map((item): ToolCallBatchOutcome => {
      if (item.kind === "permission") throw new Error("Unexpected permission item without a pending batch.");
      return item.kind === "execute" ? { ...item, approvedByUser: false } : item;
    }), signal, onEvent);
    return false;
  }

  async resolvePermissions(
    session: Session,
    run: AgentRunRecord,
    decisions: readonly PermissionResolution[],
    signal: AbortSignal,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    const batch = run.pendingToolBatch;
    if (!batch) throw new Error("Response has no pending permission batch.");
    signal.throwIfAborted();
    const decisionsById = new Map(decisions.map((decision) => [decision.permissionId, decision]));
    const outcomes: ToolCallBatchOutcome[] = batch.items.map((item) => {
      if (item.kind === "result") return item;
      if (item.kind === "execute") return { ...item, approvedByUser: false };
      const resolution = decisionsById.get(item.permissionId);
      if (!resolution) throw new Error(`Missing validated permission decision: ${item.permissionId}`);
      if (resolution.decision === "approve") {
        return { kind: "execute", toolCall: item.toolCall, requirement: item.requirement, approvedByUser: true, execution: item.execution };
      }
      return {
        kind: "result",
        toolCall: item.toolCall,
        result: {
          toolCallId: item.toolCall.id,
          toolName: item.toolCall.name,
          ok: false,
          error: resolution.reason ? `Tool call was denied by the user: ${resolution.reason}` : "Tool call was denied by the user.",
        },
        emitPostToolUse: false,
        permission: "user_denied",
      };
    });

    for (const resolution of decisions) {
      const item = findPermissionItem(run, resolution.permissionId);
      if (!item) throw new Error(`Validated permission timeline item not found: ${resolution.permissionId}`);
      item.status = resolution.decision === "approve" ? "approved" : "denied";
      if (resolution.decision === "deny" && resolution.reason) item.denialReason = resolution.reason;
    }
    delete run.pendingToolBatch;
    run.status = "in_progress";
    await this.workspaceStore.touch(session, run);
    await emit(onEvent, run, { type: "permissions_resolved", batchId: batch.id, decisions: structuredClone([...decisions]) });
    this.logger.info({
      event: "agent.permissions.resolved",
      ...logFields(session, run),
      batchId: batch.id,
      permissionCount: decisions.length,
      approvedCount: decisions.filter((item) => item.decision === "approve").length,
      deniedCount: decisions.filter((item) => item.decision === "deny").length,
    });
    await this.completeBatch(session, run, outcomes, signal, onEvent);
  }

  async closeOutstanding(
    session: Session,
    run: AgentRunRecord,
    permissionReason: string,
    toolReason: string,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    if (run.pendingToolBatch) {
      for (const permission of run.pendingToolBatch.permissions) {
        const item = findPermissionItem(run, permission.id);
        if (item?.status === "pending") {
          item.status = "denied";
          item.denialReason = permissionReason;
        }
      }
      delete run.pendingToolBatch;
    }
    const resolvedCallIds = new Set(run.timeline.filter((item) => item.type === "tool_result").map((item) => item.callId));
    const unresolved = run.timeline.filter((item): item is Extract<TranscriptItem, { type: "tool_call" }> =>
      item.type === "tool_call" && !resolvedCallIds.has(item.callId),
    );
    for (const call of unresolved) {
      await this.addToolResult(session, run, {
        id: call.callId,
        name: call.name,
        input: parseArguments(call.argumentsJson),
      }, { toolCallId: call.callId, toolName: call.name, ok: false, error: toolReason }, undefined, onEvent);
    }
  }

  private async requestPermissions(
    session: Session,
    run: AgentRunRecord,
    items: readonly PendingToolBatchItem[],
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    const createdAt = nowIso();
    const permissions: PendingPermission[] = [];
    const pendingItems = items.map((item): PendingToolBatchItem => {
      if (item.kind !== "permission") return structuredClone(item);
      const permissionItem: PermissionRequestItem = {
        id: createRandomId("permission_item"), type: "permission_request", permissionId: item.permissionId,
        callId: item.toolCall.id, prompt: item.prompt, capability: item.requirement.capability,
        ...(item.requirement.resource ? { resource: item.requirement.resource } : {}),
        ...(item.requirement.action ? { action: item.requirement.action } : {}), status: "pending",
      };
      const permission: PendingPermission = {
        id: item.permissionId, responseId: run.id, itemId: permissionItem.id,
        toolCall: structuredClone(item.toolCall), capability: item.requirement.capability,
        ...(item.requirement.resource ? { resource: item.requirement.resource } : {}),
        ...(item.requirement.action ? { action: item.requirement.action } : {}),
        requirement: structuredClone(item.requirement), prompt: item.prompt, createdAt,
      };
      permissions.push(permission);
      run.timeline.push(permissionItem);
      return structuredClone(item);
    });
    const batch: PendingToolBatch = {
      id: createRandomId("permission_batch"), responseId: run.id, items: pendingItems, permissions, createdAt,
    };
    run.pendingToolBatch = batch;
    run.status = "waiting_permission";
    await this.workspaceStore.touch(session, run);
    for (const permission of permissions) {
      const item = run.timeline.find((candidate): candidate is PermissionRequestItem =>
        candidate.type === "permission_request" && candidate.id === permission.itemId,
      );
      if (!item) throw new Error(`Permission timeline item not found: ${permission.itemId}`);
      const outputIndex = run.timeline.indexOf(item);
      await emit(onEvent, run, { type: "item_started", item, outputIndex });
      await emit(onEvent, run, { type: "item_completed", item, outputIndex });
    }
    await emit(onEvent, run, { type: "permissions_requested", batch });
  }

  private async completeBatch(
    session: Session,
    run: AgentRunRecord,
    outcomes: readonly ToolCallBatchOutcome[],
    signal: AbortSignal,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    const completed: Array<{ toolCall: ToolCall; result: ToolResult; emitPostToolUse: boolean; permission?: ToolExecutionPermission } | undefined> = new Array(outcomes.length);
    let parallelGroup: Array<{ index: number; outcome: Extract<ToolCallBatchOutcome, { kind: "execute" }> }> = [];
    const flushParallelGroup = async (): Promise<void> => {
      if (parallelGroup.length === 0) return;
      const group = parallelGroup;
      parallelGroup = [];
      const results = await mapWithConcurrencyLimit(group, MAX_PARALLEL_TOOL_CALLS, ({ outcome }) =>
        this.callTool(session, run, outcome.toolCall, outcome.requirement, outcome.approvedByUser, signal), signal);
      group.forEach(({ index, outcome }, resultIndex) => {
        const result = results[resultIndex];
        if (!result) throw new Error("Parallel tool execution did not produce a result.");
        completed[index] = {
          toolCall: outcome.toolCall,
          result,
          emitPostToolUse: true,
          permission: outcome.approvedByUser ? "user_approved" : "automatic",
        };
      });
    };
    for (const [index, outcome] of outcomes.entries()) {
      signal.throwIfAborted();
      if (outcome.kind === "result") completed[index] = outcome;
      else if (outcome.execution.concurrency === "parallel") parallelGroup.push({ index, outcome });
      else {
        await flushParallelGroup();
        completed[index] = {
          toolCall: outcome.toolCall,
          result: await this.callTool(session, run, outcome.toolCall, outcome.requirement, outcome.approvedByUser, signal),
          emitPostToolUse: true,
          permission: outcome.approvedByUser ? "user_approved" : "automatic",
        };
      }
    }
    await flushParallelGroup();
    for (const item of completed) {
      signal.throwIfAborted();
      if (!item) throw new Error("Tool batch did not produce a result for every call.");
      await this.addToolResult(session, run, item.toolCall, item.result, item.permission, onEvent);
      if (item.emitPostToolUse) await this.hookEventBus.emit("PostToolUse", { session, toolCall: item.toolCall, toolResult: item.result });
      signal.throwIfAborted();
    }
  }

  private async callTool(
    session: Session,
    run: AgentRunRecord,
    toolCall: ToolCall,
    requirement: ToolPermissionRequirement,
    approvedByUser: boolean,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = performance.now();
    const context: ToolCallContext = {
      cwd: session.cwd,
      sessionId: session.id,
      authorization: { requirement, approvedByUser },
      signal,
      modelCapabilities: run.modelSnapshot.capabilities,
    };
    const result = await this.toolRegistry.callTool(toolCall, context);
    signal.throwIfAborted();
    const fields = {
      event: "agent.tool.completed", ...logFields(session, run), toolName: toolCall.name,
      capability: requirement.capability, approvedByUser, ok: result.ok,
      durationMs: Math.round(performance.now() - startedAt), inputBytes: byteLength(toolCall.input),
      outputBytes: result.ok ? byteLength(result.output) : 0, ...(result.ok ? {} : { error: result.error }),
    };
    if (result.ok) this.logger.info(fields); else this.logger.warn(fields);
    return result;
  }

  private async addToolResult(
    session: Session,
    run: AgentRunRecord,
    toolCall: ToolCall,
    result: ToolResult,
    permission: ToolExecutionPermission | undefined,
    onEvent?: AgentDomainEventHandler,
  ): Promise<void> {
    const execution = {
      permissionMode: run.permissionSnapshot.permissionMode,
      ...(permission ? { permission } : {}),
    };
    const serialized = JSON.stringify(result.ok
      ? { ok: true, execution, output: result.output }
      : { ok: false, execution, error: result.error });
    const item: Extract<TranscriptItem, { type: "tool_result" }> = {
      id: createRandomId("fco"), type: "tool_result", callId: toolCall.id,
      content: [{ type: "json", value: JSON.parse(serialized ?? "null") },
        ...(result.ok ? structuredClone(result.content ?? []) : [])], isError: !result.ok,
    };
    const outputIndex = run.timeline.push(item) - 1;
    await this.workspaceStore.touch(session, run);
    await emit(onEvent, run, { type: "item_started", item, outputIndex });
    await emit(onEvent, run, { type: "item_completed", item, outputIndex });
    await emit(onEvent, run, { type: "tool_completed", itemId: item.id, callId: toolCall.id, result });
  }
}

function findPermissionItem(run: AgentRunRecord, permissionId: string): PermissionRequestItem | undefined {
  return run.timeline.find((item): item is PermissionRequestItem => item.type === "permission_request" && item.permissionId === permissionId);
}

async function emit(handler: AgentDomainEventHandler | undefined, run: AgentRunRecord, event: AgentDomainEvent): Promise<void> {
  if (handler) await handler(run, structuredClone(event));
}

function parseArguments(argumentsJson: string): unknown {
  if (!argumentsJson) return {};
  try { return JSON.parse(argumentsJson); } catch { return argumentsJson; }
}

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function logFields(session: Session, run: AgentRunRecord): Record<string, string> {
  return { sessionId: session.id, responseId: run.id, model: run.modelSnapshot.targetId, ...(session.projectId ? { projectId: session.projectId } : {}) };
}

async function mapWithConcurrencyLimit<T, TResult>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Concurrency limit must be a positive integer.");
  const results: Array<{ value: TResult } | undefined> = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) throw new Error("Parallel tool work item was not found.");
      results[index] = { value: await mapper(item) };
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  signal?.throwIfAborted();
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return results.map((result) => {
    if (!result) throw new Error("Parallel tool work item did not produce a result.");
    return result.value;
  });
}
