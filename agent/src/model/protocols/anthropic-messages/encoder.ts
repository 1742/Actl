import type { ToolSchema } from "../../../tools/registry.js";
import type { ContentPart, ModelTurnRequest, TranscriptItem } from "../../types.js";
import { projectToolResultImages } from "../tool-result-media.js";

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

export function toAnthropicRequest(request: ModelTurnRequest): Record<string, unknown> {
  const messages: Message[] = [];
  const system: string[] = request.instructions ? [request.instructions] : [];
  const append = (role: Message["role"], blocks: Block[], separate = false): void => {
    if (!blocks.length) return;
    const previous = messages.at(-1);
    if (!separate && previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const item of projectToolResultImages(request.transcript)) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") {
        system.push(item.content.map(instructionText).join("\n"));
      } else append(item.role, item.content.map(toContentBlock), item.role === "user");
    } else if (item.type === "reasoning") {
      // Anthropic requires the original signature when a thinking block is replayed.
      if (item.anthropicRedactedThinking) append("assistant", [{ type: "redacted_thinking", data: item.anthropicRedactedThinking }]);
      else if (item.anthropicSignature) append("assistant", [{
        type: "thinking", thinking: item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
        signature: item.anthropicSignature,
      }]);
    } else if (item.type === "tool_call") {
      let input: unknown;
      try { input = JSON.parse(item.argumentsJson); }
      catch { throw new Error(`Invalid JSON arguments for tool ${item.name}.`); }
      append("assistant", [{ type: "tool_use", id: item.callId, name: item.name, input }]);
    } else if (item.type === "tool_result") {
      append("user", [{ type: "tool_result", tool_use_id: item.callId, content: item.content.map(resultText).join("\n"), is_error: item.isError }]);
    }
  }

  const tools = request.tools.map(toTool);
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 8192,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages,
    ...(tools.length ? { tools, tool_choice: { type: "auto", disable_parallel_tool_use: !request.parallelToolCalls } } : {}),
    ...(request.reasoningEffort && ["low", "medium", "high", "xhigh", "max"].includes(request.reasoningEffort)
      ? { output_config: { effort: request.reasoningEffort } } : {}),
    stream: true,
  };
}

function toTool(tool: ToolSchema): Block {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function instructionText(part: ContentPart): string {
  if (part.type !== "text") throw new Error(`Anthropic Messages does not support ${part.type} in system instructions.`);
  return part.text;
}

function toContentBlock(part: ContentPart): Block {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "workspace_file") return { type: "text", text: part.path };
  if (part.type === "skill") return { type: "text", text: `skill:${part.id}` };
  if (part.type === "mcp_server") return { type: "text", text: `mcp:${part.name}` };
  if (part.type === "json") return { type: "text", text: JSON.stringify(part.value) };
  if (part.type === "refusal") return { type: "text", text: part.reason };
  if (part.type === "image") {
    if (part.source.type === "data") return { type: "image", source: { type: "base64", media_type: part.source.mediaType, data: part.source.data } };
    if (part.source.type === "url") return { type: "image", source: { type: "url", url: part.source.url } };
  }
  if (part.type === "file") {
    if (part.source.type === "data" && part.source.mediaType === "application/pdf")
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data: part.source.data } };
    if (part.source.type === "url") return { type: "document", source: { type: "url", url: part.source.url } };
  }
  throw new Error(`Anthropic Messages does not support ${part.type} content with source ${"source" in part ? part.source.type : "none"}.`);
}

function resultText(part: ContentPart): string {
  if (part.type === "text") return part.text;
  if (part.type === "workspace_file") return part.path;
  if (part.type === "skill") return `skill:${part.id}`;
  if (part.type === "mcp_server") return `mcp:${part.name}`;
  if (part.type === "json") return JSON.stringify(part.value);
  if (part.type === "refusal") return part.reason;
  throw new Error(`Anthropic Messages cannot encode ${part.type} as a tool result.`);
}
