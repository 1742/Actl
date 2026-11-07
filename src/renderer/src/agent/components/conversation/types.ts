import type { PermissionRequestItemDto } from "../../../../../shared/agent/responses";
import type {
  AIFunctionCallItem, AIFunctionCallOutputItem, AIMessageItem, AIReasoningItem,
  AIUnknownOutputItem, AIWebSearchCallItem,
} from "../responses/types";

export type AgentToolPresentation =
  | "shell"
  | "read"
  | "write"
  | "edit"
  | "list"
  | "glob"
  | "grep"
  | "move"
  | "delete"
  | "process"
  | "skill"
  | "web"
  | "generic";

export type AgentToolStatus = "preparing" | "waiting_permission" | "running" | "success" | "error" | "incomplete";

export interface AgentToolResultEnvelope {
  ok: boolean;
  output?: unknown;
  error?: string;
  raw: unknown;
}

export interface AgentToolTimelineBlock {
  type: "tool";
  key: string;
  call: AIFunctionCallItem;
  resultItem?: AIFunctionCallOutputItem;
  permission?: PermissionRequestItemDto;
  presentation: AgentToolPresentation;
  arguments: Record<string, unknown> | null;
  result?: AgentToolResultEnvelope;
  status: AgentToolStatus;
}

export type AgentOutputBlock =
  | { type: "message"; key: string; item: AIMessageItem }
  | { type: "reasoning"; key: string; item: AIReasoningItem }
  | AgentToolTimelineBlock
  | { type: "web_search"; key: string; item: AIWebSearchCallItem }
  | { type: "permission"; key: string; item: PermissionRequestItemDto }
  | { type: "unknown"; key: string; item: AIUnknownOutputItem };
