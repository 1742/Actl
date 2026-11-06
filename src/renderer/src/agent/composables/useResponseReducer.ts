import type { SSEFrame } from "./useResponseStream";
import type {
  AIFunctionCallItem,
  AIMessageItem,
  AIReasoningItem,
  AIResponseContext,
  AIResponseOutputItem,
  AIResponseStreamEvent,
} from "../types/aiResponse";
import { normalizeContent, normalizeResponse, normalizeResponseItem } from "../utils/aiResponse";

export type ResponseReduceStatus = "streaming" | "completed" | "failed" | "incomplete" | "cancelled";

export interface ResponseReduceResult {
  status: ResponseReduceStatus;
  context: AIResponseContext;
  message?: string;
  code?: string;
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
);

const numberAt = (event: AIResponseStreamEvent, key: string) => {
  const value = event[key];
  return typeof value === "number" ? value : Number(value);
};

export function parseResponseStreamEvent(frame: SSEFrame): AIResponseStreamEvent | null {
  if (frame.done || frame.data === "[DONE]") return null;
  try {
    return JSON.parse(frame.data) as AIResponseStreamEvent;
  } catch {
    return null;
  }
}

export function reduceResponseEvent(
  current: AIResponseContext | undefined,
  event: AIResponseStreamEvent,
): ResponseReduceResult {
  const context = current ?? contextFromEvent(event);
  if (typeof event.sequence_number === "number") {
    if (context.lastSequenceNumber !== undefined && event.sequence_number <= context.lastSequenceNumber) {
      return result(statusFromContext(context), context);
    }
    context.lastSequenceNumber = event.sequence_number;
  }
  const now = new Date().toISOString();
  context.updatedAt = now;

  switch (event.type) {
    case "response.created":
      replaceResponse(context, event.response);
      return result("streaming", context);
    case "response.output_item.added":
    case "response.output_item.done":
      setOutputItem(context, event);
      return result("streaming", context);
    case "response.content_part.added":
    case "response.content_part.done":
      setContentPart(context, event);
      return result("streaming", context);
    case "response.output_text.delta":
      appendOutputText(context, event);
      return result("streaming", context);
    case "response.output_text.done":
      finishOutputText(context, event);
      return result("streaming", context);
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done":
      setReasoningPart(context, event);
      return result("streaming", context);
    case "response.reasoning_summary_text.delta":
      appendReasoningText(context, event);
      return result("streaming", context);
    case "response.reasoning_summary_text.done":
      finishReasoningText(context, event);
      return result("streaming", context);
    case "response.reasoning_text.delta":
      appendReasoningContent(context, event);
      return result("streaming", context);
    case "response.reasoning_text.done":
      finishReasoningContent(context, event);
      return result("streaming", context);
    case "response.function_call_arguments.delta":
      updateFunctionArguments(context, event, false);
      return result("streaming", context);
    case "response.function_call_arguments.done":
      updateFunctionArguments(context, event, true);
      return result("streaming", context);
    case "response.completed":
      replaceResponse(context, event.response);
      context.completedAt = timestampFrom(event.response) ?? now;
      return result("completed", context);
    case "response.failed":
      replaceResponse(context, event.response);
      context.completedAt = timestampFrom(event.response) ?? now;
      return terminalResult("failed", context);
    case "response.incomplete":
      replaceResponse(context, event.response);
      context.completedAt = timestampFrom(event.response) ?? now;
      return terminalResult("incomplete", context);
    case "response.cancelled":
      replaceResponse(context, event.response);
      context.completedAt = timestampFrom(event.response) ?? now;
      return result("cancelled", context);
    case "error": {
      const message = typeof event.message === "string" ? event.message : "AI response failed";
      const code = typeof event.code === "string" ? event.code : undefined;
      context.response.status = "failed";
      context.response.error = { message, code, raw: event };
      return { status: "failed", context, message, code };
    }
    default:
      return result("streaming", context);
  }
}

function contextFromEvent(event: AIResponseStreamEvent): AIResponseContext {
  const now = new Date().toISOString();
  return {
    sessionId: "",
    input: [],
    response: normalizeResponse(event.response ?? { id: event.response_id, status: "in_progress", output: [] }),
    createdAt: timestampFrom(event.response) ?? now,
    updatedAt: now,
  };
}

function replaceResponse(context: AIResponseContext, source: unknown) {
  if (!source) return;
  context.response = normalizeResponse(source);
}

function result(status: ResponseReduceStatus, context: AIResponseContext): ResponseReduceResult {
  return { status, context };
}

function statusFromContext(context: AIResponseContext): ResponseReduceStatus {
  if (context.response.status === "completed") return "completed";
  if (context.response.status === "failed") return "failed";
  if (context.response.status === "incomplete") return "incomplete";
  if (context.response.status === "cancelled") return "cancelled";
  return "streaming";
}

function terminalResult(status: "failed" | "incomplete", context: AIResponseContext): ResponseReduceResult {
  return {
    status,
    context,
    message: context.response.error?.message ?? (status === "incomplete" ? "AI response incomplete" : "AI response failed"),
    code: context.response.error?.code,
  };
}

function timestampFrom(source: unknown) {
  const raw = asRecord(source);
  const value = raw.completed_at ?? raw.completedAt ?? raw.created_at ?? raw.createdAt;
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function outputItem(context: AIResponseContext, event: AIResponseStreamEvent, fallbackType: string): AIResponseOutputItem {
  const index = numberAt(event, "output_index");
  const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
  const byId = itemId ? context.response.output.find((item) => item.id === itemId) : undefined;
  if (byId) return byId;
  if (Number.isInteger(index) && context.response.output[index]) return context.response.output[index];

  const fallback = normalizeResponseItem({
    type: fallbackType,
    id: itemId,
    role: fallbackType === "message" ? "assistant" : undefined,
    summary: fallbackType === "reasoning" ? [] : undefined,
    content: fallbackType === "reasoning" ? [] : fallbackType === "message" ? [] : undefined,
    name: "",
    arguments: "",
  });
  const targetIndex = Number.isInteger(index) && index >= 0 ? index : context.response.output.length;
  context.response.output[targetIndex] = fallback;
  return fallback;
}

function setOutputItem(context: AIResponseContext, event: AIResponseStreamEvent) {
  const index = numberAt(event, "output_index");
  const item = normalizeResponseItem(event.item);
  const byId = item.id ? context.response.output.findIndex((current) => current.id === item.id) : -1;
  const targetIndex = Number.isInteger(index) && index >= 0 ? index : byId >= 0 ? byId : context.response.output.length;
  context.response.output[targetIndex] = item;
}

function messageItem(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = outputItem(context, event, "message");
  return item.type === "message" ? item as AIMessageItem : undefined;
}

function reasoningItem(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = outputItem(context, event, "reasoning");
  return item.type === "reasoning" ? item as AIReasoningItem : undefined;
}

function setContentPart(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = messageItem(context, event);
  const index = numberAt(event, "content_index");
  if (!item || !Number.isInteger(index)) return;
  item.content[index] = normalizeContent(event.part);
}

function appendOutputText(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = messageItem(context, event);
  const index = numberAt(event, "content_index");
  if (!item || !Number.isInteger(index)) return;
  const current = item.content[index];
  const part = current?.type === "output_text" ? current : { type: "output_text" as const, text: "", annotations: [] };
  part.text += typeof event.delta === "string" ? event.delta : "";
  item.content[index] = part;
}

function finishOutputText(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = messageItem(context, event);
  const index = numberAt(event, "content_index");
  if (!item || !Number.isInteger(index)) return;
  item.content[index] = { type: "output_text", text: typeof event.text === "string" ? event.text : "", annotations: [] };
}

function setReasoningPart(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = reasoningItem(context, event);
  const index = numberAt(event, "summary_index");
  if (!item || !Number.isInteger(index)) return;
  item.summary[index] = normalizeContent(event.part);
}

function appendReasoningText(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = reasoningItem(context, event);
  const index = numberAt(event, "summary_index");
  if (!item || !Number.isInteger(index)) return;
  const current = item.summary[index];
  const part = current?.type === "summary_text" ? current : { type: "summary_text" as const, text: "" };
  part.text += typeof event.delta === "string" ? event.delta : "";
  item.summary[index] = part;
}

function finishReasoningText(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = reasoningItem(context, event);
  const index = numberAt(event, "summary_index");
  if (!item || !Number.isInteger(index)) return;
  item.summary[index] = { type: "summary_text", text: typeof event.text === "string" ? event.text : "" };
}

function appendReasoningContent(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = reasoningItem(context, event);
  const index = numberAt(event, "content_index");
  if (!item || !Number.isInteger(index)) return;
  const current = item.content[index];
  const part = current?.type === "reasoning_text" ? current : { type: "reasoning_text" as const, text: "" };
  part.text += typeof event.delta === "string" ? event.delta : "";
  item.content[index] = part;
}

function finishReasoningContent(context: AIResponseContext, event: AIResponseStreamEvent) {
  const item = reasoningItem(context, event);
  const index = numberAt(event, "content_index");
  if (!item || !Number.isInteger(index)) return;
  item.content[index] = { type: "reasoning_text", text: typeof event.text === "string" ? event.text : "" };
}

function updateFunctionArguments(context: AIResponseContext, event: AIResponseStreamEvent, done: boolean) {
  const item = outputItem(context, event, "function_call");
  if (item.type !== "function_call") return;
  const call = item as AIFunctionCallItem;
  if (done) {
    call.arguments = typeof event.arguments === "string" ? event.arguments : call.arguments;
    if (typeof event.name === "string") call.name = event.name;
  } else {
    call.arguments += typeof event.delta === "string" ? event.delta : "";
  }
}
