import type { ToolSchema } from "../tools/registry.js";
import type { ReasoningEffort } from "./catalog-types.js";

export type ModelProtocol = "responses" | "chat_completions" | "anthropic_messages";
export type TranscriptRole = "system" | "developer" | "user" | "assistant";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MediaSource =
  | { type: "url"; url: string }
  | { type: "data"; data: string; mediaType: string }
  | { type: "file_id"; fileId: string };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "workspace_file"; path: string }
  | { type: "stored_file"; fileId: string }
  | { type: "skill"; id: string; name?: string }
  | { type: "mcp_server"; name: string }
  | { type: "image"; source: MediaSource; detail?: "low" | "high" | "auto" }
  | { type: "audio"; source: MediaSource; format: string }
  | { type: "file"; source: MediaSource; filename?: string; mediaType?: string }
  | { type: "json"; value: JsonValue }
  | { type: "refusal"; reason: string };

export interface TranscriptMessage {
  type: "message";
  id: string;
  role: TranscriptRole;
  content: ContentPart[];
}

export interface TranscriptReasoning {
  type: "reasoning";
  id: string;
  summary: ContentPart[];
  content: ContentPart[];
  encryptedContent?: string;
  anthropicSignature?: string;
  anthropicRedactedThinking?: string;
}

export interface TranscriptToolCall {
  type: "tool_call";
  id: string;
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface TranscriptToolResult {
  type: "tool_result";
  id: string;
  callId: string;
  content: ContentPart[];
  isError: boolean;
}

/** A provider-executed web action. It is informational, not a local tool call. */
export interface TranscriptWebSearch {
  type: "web_search";
  id: string;
  status: "in_progress" | "searching" | "completed" | "failed";
  action: {
    type: "search" | "open_page" | "find_in_page";
    queries?: string[];
    url?: string;
    pattern?: string;
    sources?: Array<{ type: "url"; url: string }>;
  };
}

export type TranscriptItem = TranscriptMessage | TranscriptReasoning | TranscriptToolCall | TranscriptToolResult | TranscriptWebSearch;

export interface ModelTurnRequest {
  model: string;
  instructions: string;
  transcript: TranscriptItem[];
  tools: ToolSchema[];
  nativeWebSearch?: boolean;
  parallelToolCalls: boolean;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
}

export type ModelFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelTurnResult {
  providerRequestId?: string;
  finishReason: ModelFinishReason;
  output: TranscriptItem[];
  usage?: ModelUsage;
}

export type ModelTurnEvent =
  | { type: "output_item_started"; item: TranscriptMessage | TranscriptReasoning | TranscriptToolCall | TranscriptWebSearch }
  | { type: "text_delta"; itemId: string; contentIndex: number; delta: string }
  | { type: "reasoning_delta"; itemId: string; section: "summary" | "content"; contentIndex: number; delta: string }
  | { type: "tool_call_delta"; itemId: string; callId: string; name?: string; argumentsDelta?: string }
  | { type: "output_item_completed"; item: TranscriptItem }
  | { type: "usage"; usage: ModelUsage };

