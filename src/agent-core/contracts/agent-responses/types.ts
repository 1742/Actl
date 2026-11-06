import type { ToolPermissionRequirement } from "../../tools/registry.js";
import type { ToolCall, ToolResult } from "../../runtime/transcript.js";
import type { ContentPart } from "../../model/types.js";
import type { PermissionMode } from "../../permissions/engine.js";

export type ResponseInputPartDto =
  | { type: "input_text"; text: string }
  | { type: "input_workspace_file"; path: string }
  | { type: "input_file"; file_id: string; filename?: string; media_type?: string; size?: number }
  | { type: "input_skill"; id: string; name?: string }
  | { type: "input_mcp_server"; name: string };

export interface ResponseInputMessageDto {
  type: "message";
  role: "user";
  content: ResponseInputPartDto[];
}

export interface ResponseTextPartDto { type: "output_text"; text: string; annotations: unknown[] }
export interface ResponseRefusalPartDto { type: "refusal"; refusal: string }
export type ResponseMessagePartDto = ResponseTextPartDto | ResponseRefusalPartDto;
export interface ResponseMessageItemDto { id: string; type: "message"; role: "assistant"; status: "in_progress" | "completed"; content: ResponseMessagePartDto[] }
export interface ResponseFunctionCallItemDto { id: string; type: "function_call"; status: "in_progress" | "completed"; call_id: string; name: string; arguments: string }
export interface ResponseFunctionCallOutputItemDto { id: string; type: "function_call_output"; status: "completed"; call_id: string; output: string; content?: ContentPart[] }
export interface ResponseReasoningItemDto {
  id: string;
  type: "reasoning";
  status: "in_progress" | "completed";
  summary: Array<{ type: "summary_text"; text: string }>;
  content: Array<{ type: "reasoning_text"; text: string }>;
}
export interface ResponseWebSearchItemDto {
  id: string;
  type: "web_search_call";
  status: "in_progress" | "searching" | "completed" | "failed";
  action: {
    type: "search" | "open_page" | "find_in_page";
    queries?: string[];
    url?: string;
    pattern?: string;
    sources?: Array<{ type: "url"; url: string }>;
  };
}
export interface PermissionRequestItemDto { id: string; type: "permission_request"; permission_id: string; call_id: string; prompt: string; capability: string; resource?: string; action?: string; denial_reason?: string; status: "pending" | "approved" | "denied" }
export type AgentItemDto = ResponseMessageItemDto | ResponseFunctionCallItemDto | ResponseFunctionCallOutputItemDto | ResponseReasoningItemDto | ResponseWebSearchItemDto | PermissionRequestItemDto;

export interface PendingPermissionDto {
  id: string;
  response_id: string;
  item_id: string;
  tool_call: ToolCall;
  capability: string;
  resource?: string;
  action?: string;
  requirement: ToolPermissionRequirement;
  prompt: string;
  created_at: string;
}

export interface PendingPermissionBatchDto {
  id: string;
  response_id: string;
  permissions: PendingPermissionDto[];
  created_at: string;
}

export interface PermissionResolutionDto {
  permission_id: string;
  decision: "approve" | "deny";
  reason?: string;
}

export interface AgentResponseDto {
  id: string;
  object: "response";
  session_id: string;
  status: "in_progress" | "waiting_permission" | "completed" | "incomplete" | "failed" | "cancelled";
  model: string;
  reasoning_effort?: string;
  permission_mode: PermissionMode;
  input: ResponseInputMessageDto[];
  output: AgentItemDto[];
  pending_permission_batch?: PendingPermissionBatchDto;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface Base { response_id: string; sequence_number: number }
export type AgentStreamEvent =
  | (Base & { type: "response.created" | "response.completed" | "response.failed" | "response.incomplete" | "response.cancelled"; response: AgentResponseDto })
  | (Base & { type: "response.output_item.added" | "response.output_item.done"; output_index: number; item: AgentItemDto })
  | (Base & { type: "response.content_part.added" | "response.content_part.done"; item_id: string; output_index: number; content_index: number; part: ResponseMessagePartDto })
  | (Base & { type: "response.output_text.delta"; item_id: string; output_index: number; content_index: number; delta: string })
  | (Base & { type: "response.output_text.done"; item_id: string; output_index: number; content_index: number; text: string })
  | (Base & { type: "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done"; item_id: string; output_index: number; summary_index: number; part: { type: "summary_text"; text: string } })
  | (Base & { type: "response.reasoning_summary_text.delta"; item_id: string; output_index: number; summary_index: number; delta: string })
  | (Base & { type: "response.reasoning_summary_text.done"; item_id: string; output_index: number; summary_index: number; text: string })
  | (Base & { type: "response.reasoning_text.delta"; item_id: string; output_index: number; content_index: number; delta: string })
  | (Base & { type: "response.reasoning_text.done"; item_id: string; output_index: number; content_index: number; text: string })
  | (Base & { type: "response.function_call_arguments.delta"; item_id: string; output_index: number; delta: string })
  | (Base & { type: "response.function_call_arguments.done"; item_id: string; output_index: number; arguments: string })
  | (Base & { type: "agent.tool.completed"; item_id: string; call_id: string; result: ToolResult })
  | (Base & { type: "agent.permissions.requested"; batch: PendingPermissionBatchDto })
  | (Base & { type: "agent.permissions.resolved"; batch_id: string; decisions: PermissionResolutionDto[] })
  | (Base & { type: "error"; code: string | null; message: string; param: string | null });

export type AgentStreamEventPayload = AgentStreamEvent extends infer Event
  ? Event extends Base ? Omit<Event, keyof Base> : never
  : never;
export type AgentStreamEventHandler = (event: AgentStreamEvent) => void | Promise<void>;
