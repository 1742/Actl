import { z } from "zod";
import type { TranscriptMessage } from "../model/types.js";
import type { AgentTimelineItem, PendingToolBatch } from "../runtime/agent-domain.js";

const mediaSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string() }).strict(),
  z.object({ type: z.literal("data"), data: z.string(), mediaType: z.string() }).strict(),
  z.object({ type: z.literal("file_id"), fileId: z.string() }).strict(),
]);

const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("workspace_file"), path: z.string() }).strict(),
  z.object({ type: z.literal("stored_file"), fileId: z.string() }).strict(),
  z.object({ type: z.literal("skill"), id: z.string(), name: z.string().optional() }).strict(),
  z.object({ type: z.literal("mcp_server"), name: z.string() }).strict(),
  z.object({ type: z.literal("image"), source: mediaSourceSchema, detail: z.enum(["low", "high", "auto"]).optional() }).strict(),
  z.object({ type: z.literal("audio"), source: mediaSourceSchema, format: z.string() }).strict(),
  z.object({ type: z.literal("file"), source: mediaSourceSchema, filename: z.string().optional(), mediaType: z.string().optional() }).strict(),
  z.object({ type: z.literal("json"), value: z.json() }).strict(),
  z.object({ type: z.literal("refusal"), reason: z.string() }).strict(),
]);

const messageSchema = z.object({
  type: z.literal("message"),
  id: z.string(),
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.array(contentPartSchema),
}).strict();

const reasoningSchema = z.object({
  type: z.literal("reasoning"),
  id: z.string(),
  summary: z.array(contentPartSchema),
  content: z.array(contentPartSchema).default([]),
  encryptedContent: z.string().optional(),
  anthropicSignature: z.string().optional(),
  anthropicRedactedThinking: z.string().optional(),
}).strict();

const toolCallItemSchema = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  callId: z.string(),
  name: z.string(),
  argumentsJson: z.string(),
}).strict();

const toolResultSchema = z.object({
  type: z.literal("tool_result"),
  id: z.string(),
  callId: z.string(),
  content: z.array(contentPartSchema),
  isError: z.boolean(),
}).strict();

const webSearchItemSchema = z.object({
  type: z.literal("web_search"),
  id: z.string(),
  status: z.enum(["in_progress", "searching", "completed", "failed"]),
  action: z.object({
    type: z.enum(["search", "open_page", "find_in_page"]),
    queries: z.array(z.string()).optional(), url: z.string().optional(), pattern: z.string().optional(),
    sources: z.array(z.object({ type: z.literal("url"), url: z.string() }).strict()).optional(),
  }).strict(),
}).strict();

const permissionItemSchema = z.object({
  type: z.literal("permission_request"),
  id: z.string(),
  permissionId: z.string(),
  callId: z.string(),
  prompt: z.string(),
  capability: z.string(),
  resource: z.string().optional(),
  action: z.string().optional(),
  denialReason: z.string().optional(),
  status: z.enum(["pending", "approved", "denied"]),
}).strict();

const timelineItemSchema = z.discriminatedUnion("type", [
  messageSchema,
  reasoningSchema,
  toolCallItemSchema,
  toolResultSchema,
  webSearchItemSchema,
  permissionItemSchema,
]);

const permissionRequirementSchema = z.object({
  capability: z.string(),
  resource: z.string().optional(),
  action: z.string().optional(),
}).strict();

const runtimeToolCallSchema = z.object({ id: z.string(), name: z.string(), input: z.unknown() }).strict();
const toolResultValueSchema = z.discriminatedUnion("ok", [
  z.object({ toolCallId: z.string(), toolName: z.string(), ok: z.literal(true), output: z.unknown().optional() }).strict(),
  z.object({ toolCallId: z.string(), toolName: z.string(), ok: z.literal(false), error: z.string() }).strict(),
]);
const executionPolicySchema = z.object({ concurrency: z.enum(["parallel", "exclusive"]) }).strict();
const pendingPermissionSchema = z.object({
  id: z.string(), responseId: z.string(), itemId: z.string(), toolCall: runtimeToolCallSchema,
  capability: z.string(), resource: z.string().optional(), action: z.string().optional(),
  requirement: permissionRequirementSchema, prompt: z.string(), createdAt: z.string(),
}).strict();
const pendingToolBatchItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("result"), toolCall: runtimeToolCallSchema, result: toolResultValueSchema, emitPostToolUse: z.boolean(), permission: z.enum(["automatic", "user_approved", "user_denied", "policy_denied"]).optional() }).strict(),
  z.object({ kind: z.literal("execute"), toolCall: runtimeToolCallSchema, requirement: permissionRequirementSchema, execution: executionPolicySchema }).strict(),
  z.object({ kind: z.literal("permission"), permissionId: z.string(), toolCall: runtimeToolCallSchema, requirement: permissionRequirementSchema, execution: executionPolicySchema, prompt: z.string() }).strict(),
]);
const pendingToolBatchSchema = z.object({
  id: z.string(), responseId: z.string(), items: z.array(pendingToolBatchItemSchema),
  permissions: z.array(pendingPermissionSchema).min(1), createdAt: z.string(),
}).strict();

export function parseSqliteMessage(value: string): TranscriptMessage {
  return messageSchema.parse(JSON.parse(value)) as TranscriptMessage;
}

export function parseSqliteTimelineItem(value: string): AgentTimelineItem {
  return timelineItemSchema.parse(JSON.parse(value)) as AgentTimelineItem;
}

export function parseSqlitePendingBatch(value: string): PendingToolBatch {
  return pendingToolBatchSchema.parse(JSON.parse(value)) as PendingToolBatch;
}
