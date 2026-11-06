import type { ToolExecutionPolicy, ToolPermissionRequirement } from "../tools/registry.js";
import type {
  TranscriptItem,
  TranscriptMessage,
  TranscriptReasoning,
  TranscriptToolCall,
  TranscriptToolResult,
} from "../model/types.js";
import type { ToolCall, ToolResult } from "./transcript.js";
import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import type { RunPermissionSnapshot } from "../permissions/engine.js";

export interface PermissionRequestItem {
  type: "permission_request";
  id: string;
  permissionId: string;
  callId: string;
  prompt: string;
  capability: string;
  resource?: string;
  action?: string;
  denialReason?: string;
  status: "pending" | "approved" | "denied";
}

export type AgentTimelineItem = TranscriptItem | PermissionRequestItem;

export interface PendingPermission {
  id: string;
  responseId: string;
  itemId: string;
  toolCall: ToolCall;
  capability: string;
  resource?: string;
  action?: string;
  requirement: ToolPermissionRequirement;
  prompt: string;
  createdAt: string;
}

export type PendingToolBatchItem =
  | {
      kind: "result";
      toolCall: ToolCall;
      result: ToolResult;
      emitPostToolUse: boolean;
      permission?: "automatic" | "user_approved" | "user_denied" | "policy_denied";
    }
  | {
      kind: "execute";
      toolCall: ToolCall;
      requirement: ToolPermissionRequirement;
      execution: ToolExecutionPolicy;
    }
  | {
      kind: "permission";
      permissionId: string;
      toolCall: ToolCall;
      requirement: ToolPermissionRequirement;
      execution: ToolExecutionPolicy;
      prompt: string;
    };

export interface PendingToolBatch {
  id: string;
  responseId: string;
  items: PendingToolBatchItem[];
  permissions: PendingPermission[];
  createdAt: string;
}

export interface PermissionResolution {
  permissionId: string;
  decision: "approve" | "deny";
  reason?: string;
}

export type AgentRunStatus = "in_progress" | "waiting_permission" | "completed" | "incomplete" | "failed" | "cancelled";

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  modelSnapshot: ModelExecutionSnapshot;
  permissionSnapshot: RunPermissionSnapshot;
  input: TranscriptMessage[];
  timeline: AgentTimelineItem[];
  pendingToolBatch?: PendingToolBatch;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  nextSequenceNumber: number;
}

export type AgentDomainEvent =
  | { type: "run_created"; run: AgentRunRecord }
  | { type: "item_started"; item: AgentTimelineItem; outputIndex: number }
  | { type: "text_delta"; itemId: string; outputIndex: number; contentIndex: number; delta: string }
  | { type: "reasoning_delta"; itemId: string; outputIndex: number; section: "summary" | "content"; contentIndex: number; delta: string }
  | { type: "tool_arguments_delta"; itemId: string; outputIndex: number; delta: string }
  | { type: "item_completed"; item: TranscriptItem | PermissionRequestItem; outputIndex: number }
  | { type: "tool_completed"; itemId: string; callId: string; result: ToolResult }
  | { type: "permissions_requested"; batch: PendingToolBatch }
  | { type: "permissions_resolved"; batchId: string; decisions: PermissionResolution[] }
  | { type: "run_completed"; run: AgentRunRecord }
  | { type: "run_failed"; run: AgentRunRecord }
  | { type: "run_incomplete"; run: AgentRunRecord }
  | { type: "run_cancelled"; run: AgentRunRecord }
  | { type: "error"; code: string | null; message: string; param: string | null };

export type AgentDomainEventHandler = (run: AgentRunRecord, event: AgentDomainEvent) => void | Promise<void>;

/**
 * Build a transcript for model consumption, skipping the prefix represented by
 * the session's single rolling summary.
 */
export function buildModelTranscript(runs: readonly AgentRunRecord[], summarizedRunCount = 0): TranscriptItem[] {
  return runs
    .slice(summarizedRunCount)
    .flatMap((run) => [
      ...run.input.map((message) => structuredClone(message)),
      ...run.timeline.filter((item): item is TranscriptItem => item.type !== "permission_request"),
    ]);
}

export function isTranscriptItem(item: AgentTimelineItem): item is TranscriptItem {
  return item.type !== "permission_request";
}

export function findUnresolvedToolCalls(timeline: readonly AgentTimelineItem[]): TranscriptToolCall[] {
  const resultCallIds = new Set(
    timeline.flatMap((item) => item.type === "tool_result" ? [item.callId] : []),
  );
  return timeline.filter(
    (item): item is TranscriptToolCall => item.type === "tool_call" && !resultCallIds.has(item.callId),
  );
}

export type AgentModelItem = TranscriptMessage | TranscriptReasoning | TranscriptToolCall | TranscriptToolResult;
