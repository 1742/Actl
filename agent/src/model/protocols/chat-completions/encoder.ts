import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions/completions";
import type { ToolSchema } from "../../../tools/registry.js";
import type { ContentPart, TranscriptItem, TranscriptMessage } from "../../types.js";
import { projectToolResultImages } from "../tool-result-media.js";

export function toChatTools(tools: ToolSchema[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false },
  }));
}

export function toChatMessages(instructions: string, transcript: TranscriptItem[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = instructions ? [{ role: "system", content: instructions }] : [];
  let pendingContent: string | undefined;
  let pendingReasoning = "";
  let pendingToolCalls: NonNullable<Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]> = [];

  const flushAssistant = (): void => {
    if (pendingContent === undefined && pendingReasoning === "" && pendingToolCalls.length === 0) return;
    const message = {
      role: "assistant" as const,
      content: pendingContent ?? null,
      ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
      ...(pendingToolCalls.length > 0 ? { tool_calls: pendingToolCalls } : {}),
    };
    messages.push(message as ChatCompletionMessageParam);
    pendingContent = undefined;
    pendingReasoning = "";
    pendingToolCalls = [];
  };

  for (const item of projectToolResultImages(transcript)) {
    if (item.type === "reasoning") {
      if (pendingContent !== undefined || pendingToolCalls.length > 0) flushAssistant();
      pendingReasoning += contentToText(item.content.length > 0 ? item.content : item.summary);
    }
    if (item.type === "message") {
      if (item.role === "assistant") {
        if (pendingContent !== undefined || pendingToolCalls.length > 0) flushAssistant();
        pendingContent = contentToText(item.content);
      } else {
        flushAssistant();
        messages.push(toChatMessage(item));
      }
    }
    else if (item.type === "tool_call") pendingToolCalls.push({
      id: item.callId,
      type: "function",
      function: { name: item.name, arguments: item.argumentsJson },
    });
    else if (item.type === "tool_result") {
      flushAssistant();
      messages.push({ role: "tool", tool_call_id: item.callId, content: contentToText(item.content) });
    }
  }
  flushAssistant();
  return messages;
}

function toChatMessage(message: TranscriptMessage): ChatCompletionMessageParam {
  if (message.role === "assistant") return { role: "assistant", content: contentToText(message.content) };
  const content = message.content.map(toChatContent);
  if (message.role === "developer") return { role: "system", content: instructionText(message) };
  if (message.role === "system") return { role: "system", content: instructionText(message) };
  return { role: "user", content };
}

function instructionText(message: TranscriptMessage): string {
  return message.content.map((part) => {
    if (part.type !== "text") throw new Error(`Chat Completions provider does not support ${part.type} in a ${message.role} message.`);
    return part.text;
  }).join("\n");
}

function toChatContent(part: ContentPart): { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail: "low" | "high" | "auto" } } | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } } {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "workspace_file") return { type: "text", text: part.path };
  if (part.type === "stored_file") throw new Error("Stored files must be materialized before Chat Completions encoding.");
  if (part.type === "skill") return { type: "text", text: `skill:${part.id}` };
  if (part.type === "mcp_server") return { type: "text", text: `mcp:${part.name}` };
  if (part.type === "image") return { type: "image_url", image_url: { url: mediaUrl(part.source), ...(part.detail ? { detail: part.detail } : { detail: "auto" }) } };
  if (part.type === "audio" && part.source.type === "data" && (part.format === "wav" || part.format === "mp3")) {
    return { type: "input_audio", input_audio: { data: part.source.data, format: part.format } };
  }
  throw new Error(`Chat Completions provider does not support ${part.type} content in this form.`);
}

function mediaUrl(source: Extract<ContentPart, { type: "image" }>["source"]): string {
  if (source.type === "url") return source.url;
  if (source.type === "data") return `data:${source.mediaType};base64,${source.data}`;
  throw new Error("Chat Completions provider cannot use a provider file ID as an image URL.");
}

function contentToText(parts: ContentPart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "workspace_file") return part.path;
    if (part.type === "stored_file") return `[uploaded file: ${part.fileId}]`;
    if (part.type === "skill") return `skill:${part.id}`;
    if (part.type === "mcp_server") return `mcp:${part.name}`;
    if (part.type === "json") return JSON.stringify(part.value);
    if (part.type === "refusal") return part.reason;
    throw new Error(`Chat Completions provider cannot encode ${part.type} as text.`);
  }).join("\n");
}
