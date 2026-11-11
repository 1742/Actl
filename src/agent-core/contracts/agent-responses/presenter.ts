import type { ContentPart, TranscriptMessage } from "../../model/types.js";
import type { AgentRunRecord, AgentTimelineItem, PendingPermission, PendingToolBatch } from "../../runtime/agent-domain.js";
import { createRandomId } from "../../utils.js";
import type {
  AgentItemDto,
  AgentResponseDto,
  PendingPermissionBatchDto,
  PendingPermissionDto,
  ResponseInputMessageDto,
  ResponseInputPartDto,
  ResponseMessagePartDto,
} from "../../../shared/agent/responses.js";
import type { StoredFileInputMetadata } from "../../stored-files/stored-file-service.js";

export type StoredFileMetadataResolver = (sessionId: string, fileId: string) => StoredFileInputMetadata | undefined;

export function inputFromDto(input: readonly ResponseInputMessageDto[]): TranscriptMessage[] {
  return input.map((message) => {
    const normalizedParts = [
      ...message.content.filter((part) => part.type === "input_file"),
      ...message.content.filter((part) => part.type !== "input_file"),
    ];
    return {
      type: "message",
      id: createRandomId("msg"),
      role: "user",
      source: { kind: "user" },
      content: normalizedParts.map((part) => {
        if (part.type === "input_text") return { type: "text" as const, text: part.text };
        if (part.type === "input_workspace_file") return { type: "workspace_file" as const, path: part.path };
        if (part.type === "input_file") return { type: "stored_file" as const, fileId: part.file_id };
        if (part.type === "input_skill") return { type: "skill" as const, id: part.id };
        return { type: "mcp_server" as const, name: part.name };
      }),
    };
  });
}

export function toAgentResponseDto(run: AgentRunRecord, resolveStoredFile?: StoredFileMetadataResolver): AgentResponseDto {
  return {
    id: run.id,
    object: "response",
    session_id: run.sessionId,
    status: run.status,
    model: run.modelSnapshot.targetId,
    ...(run.modelSnapshot.reasoningEffort ? { reasoning_effort: run.modelSnapshot.reasoningEffort } : {}),
    permission_mode: run.permissionSnapshot.permissionMode,
    input: run.input.map((message) => toInputDto(message, run.sessionId, resolveStoredFile)),
    output: run.timeline.map((item) => toAgentItemDto(item, "completed", run)),
    ...(run.pendingToolBatch ? { pending_permission_batch: toPendingPermissionBatchDto(run.pendingToolBatch) } : {}),
    ...(run.error ? { error: structuredClone(run.error) } : {}),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
  };
}

export function toAgentItemDto(item: AgentTimelineItem, status: "in_progress" | "completed", run?: AgentRunRecord): AgentItemDto {
  if (item.type === "message") return {
    id: item.id,
    type: "message",
    role: item.role,
    ...(item.source ? { source: item.source } : {}),
    status,
    content: item.source?.kind === 'mail' ? [] : item.content.flatMap((part): ResponseMessagePartDto[] => {
      if (part.type === "text") return [{ type: "output_text" as const, text: part.text, annotations: [] }];
      if (part.type === "refusal") return [{ type: "refusal" as const, refusal: part.reason }];
      return [];
    }),
  };
  if (item.type === "tool_call") return {
    id: item.id,
    type: "function_call",
    status,
    call_id: item.callId,
    name: item.name,
    arguments: projectToolArguments(item.name, item.argumentsJson),
  };
  if (item.type === "tool_result") return {
    id: item.id,
    type: "function_call_output",
    status: "completed",
    call_id: item.callId,
    // Keep the execution envelope parseable by existing clients; rich content
    // travels separately instead of appending non-JSON text to the envelope.
    output: item.content[0]?.type === "json"
      ? JSON.stringify(projectToolEnvelope(item.content[0].value, run, item.callId))
      : contentToText(item.content),
    ...(item.content[0]?.type === "json" && item.content.length > 1 ? { content: structuredClone(item.content.slice(1)) } : {}),
  };
  if (item.type === "reasoning") return {
    id: item.id,
    type: "reasoning",
    status,
    summary: item.summary.flatMap((part) => part.type === "text" ? [{ type: "summary_text" as const, text: part.text }] : []),
    content: item.content.flatMap((part) => part.type === "text" ? [{ type: "reasoning_text" as const, text: part.text }] : []),
  };
  if (item.type === "web_search") return {
    id: item.id,
    type: "web_search_call",
    status,
    action: structuredClone(item.action),
  };
  return {
    id: item.id,
    type: "permission_request",
    permission_id: item.permissionId,
    call_id: item.callId,
    prompt: item.prompt,
    capability: item.capability,
    ...(item.resource ? { resource: item.resource } : {}),
    ...(item.action ? { action: item.action } : {}),
    ...(item.denialReason ? { denial_reason: item.denialReason } : {}),
    status: item.status,
  };
}

export function projectToolArguments(name: string, args: string): string {
  if (!args || !mayBeMailTool(name)) return args;
  try {
    const value: unknown = JSON.parse(args);
    if (isRecord(value) && typeof value.subject === 'string') return JSON.stringify({ subject: value.subject });
  } catch { /* Arguments can be incomplete while streaming. */ }
  return '{}';
}

export function mayBeMailTool(name: string): boolean {
  return 'send_mail'.startsWith(name);
}

export function projectToolOutput(name: string | undefined, output: unknown): unknown {
  if (name === 'read_mail' && isRecord(output)) {
    const { body: _body, ...metadata } = output;
    return metadata;
  }
  if (name === 'wait_agents' && Array.isArray(output)) return output.map(withoutAgentOutput);
  if (name === 'list_agents' && isRecord(output) && Array.isArray(output.agents)) {
    return { ...output, agents: output.agents.map(withoutAgentOutput) };
  }
  return output;
}

function projectToolEnvelope(value: unknown, run: AgentRunRecord | undefined, callId: string): unknown {
  const call = run?.timeline.find((item) => item.type === 'tool_call' && item.callId === callId);
  return call?.type === 'tool_call' && isRecord(value) && 'output' in value
    ? { ...value, output: projectToolOutput(call.name, value.output) }
    : value;
}

function withoutAgentOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { output: _output, ...status } = value;
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPendingPermissionDto(permission: PendingPermission): PendingPermissionDto {
  return {
    id: permission.id,
    response_id: permission.responseId,
    item_id: permission.itemId,
    tool_call: structuredClone(permission.toolCall),
    capability: permission.capability,
    ...(permission.resource ? { resource: permission.resource } : {}),
    ...(permission.action ? { action: permission.action } : {}),
    requirement: structuredClone(permission.requirement),
    prompt: permission.prompt,
    created_at: permission.createdAt,
  };
}

export function toPendingPermissionBatchDto(batch: PendingToolBatch): PendingPermissionBatchDto {
  return {
    id: batch.id,
    response_id: batch.responseId,
    permissions: batch.permissions.map(toPendingPermissionDto),
    created_at: batch.createdAt,
  };
}

function toInputDto(
  message: TranscriptMessage,
  sessionId: string,
  resolveStoredFile?: StoredFileMetadataResolver,
): ResponseInputMessageDto {
  return {
    type: "message",
    role: "user",
    ...(message.source ? { source: message.source } : {}),
    content: message.content.flatMap((part): ResponseInputPartDto[] => {
      if (part.type === "text") return [{ type: "input_text" as const, text: part.text }];
      if (part.type === "workspace_file") return [{ type: "input_workspace_file" as const, path: part.path }];
      if (part.type === "mcp_server") return [{ type: "input_mcp_server" as const, name: part.name }];
      if (part.type === "stored_file") {
        const metadata = resolveStoredFile?.(sessionId, part.fileId);
        return [{ type: "input_file" as const, file_id: part.fileId, ...(metadata ?? {}) }];
      }
      if (part.type === "skill") return [{
        type: "input_skill" as const,
        id: part.id,
        ...(part.name ? { name: part.name } : {}),
      }];
      return [];
    }),
  };
}

function contentToText(content: ContentPart[]): string {
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "workspace_file") return `@${part.path}`;
    if (part.type === "stored_file") return `[uploaded file: ${part.fileId}]`;
    if (part.type === "skill") return `/${part.name ?? part.id}`;
    if (part.type === "mcp_server") return `mcp:${part.name}`;
    if (part.type === "json") return JSON.stringify(part.value);
    if (part.type === "refusal") return part.reason;
    return `[${part.type}]`;
  }).join("\n");
}
