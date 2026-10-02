import type { FunctionTool, ResponseInputItem, ResponseOutputMessage, ResponseReasoningItem, Tool, WebSearchTool } from "openai/resources/responses/responses";
import type { ToolSchema } from "../../../tools/registry.js";
import type { ContentPart, TranscriptItem, TranscriptMessage } from "../../types.js";
import { projectToolResultImages } from "../tool-result-media.js";

export function toResponseTools(tools: ToolSchema[], nativeWebSearch = false): Tool[] {
  const encoded: Tool[] = tools.map((tool): FunctionTool => ({
    type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false,
  }));
  if (nativeWebSearch) encoded.push({ type: "web_search" } satisfies WebSearchTool);
  return encoded;
}

export function toResponseInput(items: TranscriptItem[]): ResponseInputItem[] {
  return projectToolResultImages(items).flatMap((item): ResponseInputItem[] => {
    if (item.type === "message") return [toResponseMessage(item)];
    if (item.type === "reasoning") return [toResponseReasoning(item)];
    if (item.type === "tool_call") return [{ type: "function_call", call_id: item.callId, name: item.name, arguments: item.argumentsJson }];
    if (item.type === "tool_result") return [{ type: "function_call_output", call_id: item.callId, output: contentToText(item.content) }];
    return [];
  });
}

function toResponseReasoning(item: Extract<TranscriptItem, { type: "reasoning" }>): ResponseReasoningItem {
  return {
    type: "reasoning",
    id: item.id,
    summary: item.summary.flatMap((part) => part.type === "text" ? [{ type: "summary_text" as const, text: part.text }] : []),
    content: item.content.flatMap((part) => part.type === "text" ? [{ type: "reasoning_text" as const, text: part.text }] : []),
    ...(item.encryptedContent ? { encrypted_content: item.encryptedContent } : {}),
  };
}

function toResponseMessage(item: TranscriptMessage): ResponseInputItem {
  if (item.role === "assistant") return toResponseAssistantMessage(item);
  const content: unknown[] = [];
  for (const part of item.content) {
    if (part.type === "text") { content.push({ type: "input_text", text: part.text }); continue; }
    if (part.type === "workspace_file") { content.push({ type: "input_text", text: part.path }); continue; }
    if (part.type === "stored_file") throw new Error("Stored files must be materialized before Responses encoding.");
    if (part.type === "skill") { content.push({ type: "input_text", text: `skill:${part.id}` }); continue; }
    if (part.type === "mcp_server") { content.push({ type: "input_text", text: `mcp:${part.name}` }); continue; }
    if (part.type === "refusal") { content.push({ type: "input_text", text: part.reason }); continue; }
    if (part.type === "json") { content.push({ type: "input_text", text: JSON.stringify(part.value) }); continue; }
    if (part.type === "image" && part.source.type === "url") { content.push({ type: "input_image", image_url: part.source.url, detail: part.detail ?? "auto" }); continue; }
    if (part.type === "image" && part.source.type === "data") { content.push({ type: "input_image", image_url: `data:${part.source.mediaType};base64,${part.source.data}`, detail: part.detail ?? "auto" }); continue; }
    if (part.type === "file" && part.source.type === "url") { content.push({ type: "input_file", file_url: part.source.url, ...(part.filename ? { filename: part.filename } : {}) }); continue; }
    if (part.type === "file" && part.source.type === "file_id") { content.push({ type: "input_file", file_id: part.source.fileId, ...(part.filename ? { filename: part.filename } : {}) }); continue; }
    throw new Error(`Responses provider does not support ${part.type} content with source ${"source" in part ? part.source.type : "none"}.`);
  }
  return { type: "message", role: item.role, content } as ResponseInputItem;
}

function toResponseAssistantMessage(item: TranscriptMessage): ResponseOutputMessage {
  return {
    type: "message",
    id: item.id,
    role: "assistant",
    status: "completed",
    content: item.content.map((part) => {
      if (part.type === "text") return { type: "output_text" as const, text: part.text, annotations: [] };
      if (part.type === "refusal") return { type: "refusal" as const, refusal: part.reason };
      if (part.type === "workspace_file") return { type: "output_text" as const, text: part.path, annotations: [] };
      if (part.type === "skill") return { type: "output_text" as const, text: `skill:${part.id}`, annotations: [] };
      if (part.type === "mcp_server") return { type: "output_text" as const, text: `mcp:${part.name}`, annotations: [] };
      if (part.type === "json") return { type: "output_text" as const, text: JSON.stringify(part.value), annotations: [] };
      throw new Error(`Responses provider does not support ${part.type} content in an assistant message.`);
    }),
  };
}

function contentToText(content: ContentPart[]): string {
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "workspace_file") return part.path;
    if (part.type === "stored_file") return `[uploaded file: ${part.fileId}]`;
    if (part.type === "skill") return `skill:${part.id}`;
    if (part.type === "mcp_server") return `mcp:${part.name}`;
    if (part.type === "json") return JSON.stringify(part.value);
    if (part.type === "refusal") return part.reason;
    throw new Error(`Responses provider cannot encode ${part.type} as a function result.`);
  }).join("\n");
}
