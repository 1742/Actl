import type { ActionResult } from "../../types/common";
import type { PickedFile } from "../composables/useFileBridge";
import type {
  AIFunctionCallItem,
  AIFunctionCallOutputItem,
  AIWebSearchCallItem,
  AIMessageItem,
  AIReasoningItem,
  AIResponseContext,
  AIResponseInputItem,
  AIResponseOutputItem,
  AIResponseStreamEvent,
  AIUnknownOutputItem,
  AISkillContent,
  AIWorkspaceFileContent,
} from "./aiResponse";

export type { ActionResult, AIResponseContext, AIResponseInputItem, AIResponseOutputItem };

export interface AgentInputTextContent {
  type: "input_text";
  text: string;
}

export interface AgentInputFileContent {
  type: "input_file";
  file_id: string;
  filename?: string;
  media_type?: string;
  size?: number;
}

export interface AgentInputMcpServerContent {
  type: "input_mcp_server";
  name: string;
}

export type AgentInputContent = AgentInputTextContent | AgentInputFileContent | AIWorkspaceFileContent | AISkillContent | AgentInputMcpServerContent;

export interface AgentInputMessage {
  type: "message";
  role: "user";
  content: AgentInputContent[];
}

export type AgentComposerNode =
  | { type: "text"; text: string }
  | { type: "skill"; id: string; name: string; scope: string }
  | { type: "mcp_server"; name: string }
  | { type: "workspace_file"; path: string; name: string };

export interface AgentComposerDocument {
  version: 1;
  nodes: AgentComposerNode[];
}

export type AgentAttachmentStatus = "pending" | "uploading" | "uploaded" | "error";

export interface RuntimeStoredFile {
  id: string;
  object: "stored_file";
  session_id: string;
  filename: string;
  media_type: string;
  size: number;
  created_at: string;
}

export interface AgentComposerAttachment {
  id: string;
  selected: PickedFile;
  status: AgentAttachmentStatus;
  storedFile?: RuntimeStoredFile;
  error?: string;
}

export interface ResolvedAgentComposer {
  content: AgentInputContent[];
  error?: string;
}

export interface RuntimeWorkspaceFile {
  type: "workspace_file";
  path: string;
  name: string;
}

export interface RuntimeWorkspaceFileSearchResult {
  data: RuntimeWorkspaceFile[];
  truncated: boolean;
}

export interface RuntimeWorkspaceDirectoryEntry {
  type: "file" | "directory";
  name: string;
  path: string;
}

export interface RuntimeWorkspaceTree {
  path: string;
  entries: RuntimeWorkspaceDirectoryEntry[];
  truncated: boolean;
}

export type AgentResponseStatus = "in_progress" | "waiting_permission" | "completed" | "incomplete" | "failed" | "cancelled";
export type AgentViewStatus = "idle" | "running" | "waiting_permission" | "stopping";
export type AgentComposerContextKey = `session:${string}` | `project:${string}:draft` | `standalone:${AgentRuntimeKind}:draft`;

export type RuntimeModelProtocol = "responses" | "chat_completions" | "anthropic_messages";
export type RuntimeReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentPermissionMode = "plan" | "ask" | "accept_edits" | "full_access";

export type AgentRuntimeKind = "local";
export type AgentRuntimeAvailability = "idle" | "checking" | "available" | "unavailable";

export interface AgentRuntimeCapabilities {
  modelConfiguration: boolean;
  skills: boolean;
  workspace: boolean;
  uploadFile: boolean;
  permissions: boolean;
  sessionProjectBinding: boolean;
  localProjectPaths: boolean;
}

export interface RuntimeModelCapabilities {
  input: { text: true; imageMimeTypes: string[]; audioMimeTypes: string[] };
  toolCalling: boolean;
  parallelToolCalls: boolean;
  nativeWebSearch: boolean;
  reasoningEfforts: RuntimeReasoningEffort[];
  defaultReasoningEffort?: RuntimeReasoningEffort;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface RuntimeModel {
  id: string;
  providerAccountId: string;
  providerModel: string;
  protocol: RuntimeModelProtocol;
  displayName: string;
  enabled: boolean;
  compatible?: boolean;
  incompatibilityReasons?: string[];
  capabilities: RuntimeModelCapabilities;
}

export interface RuntimeModelConfig {
  providerModel: string;
  displayName: string;
  protocol: RuntimeModelProtocol;
  capabilities: RuntimeModelCapabilities;
}

export interface RuntimeModelCatalog {
  object: string;
  data: RuntimeModel[];
  selectedModelTargetId?: string;
  selectedReasoningEffort?: RuntimeReasoningEffort;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface RuntimeProviderAccount {
  id: string;
  displayName: string;
  baseURL: string;
  enabled: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuntimeProviderAccount { displayName: string; baseURL: string; apiKey: string; }

export interface RuntimeSkillDiagnostic extends Record<string, unknown> {
  code?: string;
  message?: string;
}

export interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  description_zh?: string;
  category?: string;
  l1_category?: string;
  l2_category?: string;
  tags: string[];
  version?: string;
  icon?: string;
  source: {
    provider: string;
    scope: string;
    location: string;
  };
  available: boolean;
  diagnostics: RuntimeSkillDiagnostic[];
}

export interface RuntimeSkillCatalog {
  data: RuntimeSkill[];
}

export interface RuntimeSkillContext {
  projectId?: string;
  sessionId?: string;
}

export interface AgentProject {
  id: string;
  cwd: string;
  name?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSession {
  id: string;
  projectId: string | null;
  title?: string;
  created_at: string;
  updated_at: string;
}

/** UI-side project identity. `id` is source-qualified; `runtimeId` is sent to the API. */
export interface RuntimeProject extends AgentProject {
  runtimeKind: AgentRuntimeKind;
  runtimeId: string;
}

/** UI-side session identity. `id` and `projectId` are source-qualified. */
export interface RuntimeSession extends Omit<AgentSession, "projectId"> {
  runtimeKind: AgentRuntimeKind;
  runtimeId: string;
  runtimeProjectId: string | null;
  projectId: string | null;
}

export interface PendingPermission {
  id: string;
  response_id: string;
  item_id: string;
  tool_call: { id: string; name: string; input: unknown };
  capability: string;
  resource?: string;
  action?: string;
  requirement: {
    capability: string;
    resource?: string;
    action?: string;
    defaultDecision: "allow" | "ask" | "deny";
    prompt?: string;
    reason?: string;
  };
  prompt: string;
  created_at: string;
}

export interface PendingPermissionBatch {
  id: string;
  response_id: string;
  permissions: PendingPermission[];
  created_at: string;
}

export interface AgentRuntimeConflict {
  sessionId: string;
  responseId?: string;
}

export interface AgentSessionRuntime {
  responses: AIResponseContext[];
  status: AgentViewStatus;
  pendingPermissionBatch?: PendingPermissionBatch;
  activeResponseId: string;
  errorMessage: string;
  loadingHistory: boolean;
  hydrated: boolean;
  conflict?: AgentRuntimeConflict;
  context?: SessionContextSummary;
  compressionInProgress: boolean;
}

export interface RuntimeWebSearchSettings {
  provider: "brave" | "tavily" | "serper" | "bocha";
  mode: "auto" | "native" | "external";
  enabled: boolean;
  baseUrl: string;
  hasCredential: boolean;
  updatedAt?: string;
}

export interface RuntimePromptBlock {
  id: string;
  title: string;
  text: string;
  enabled: boolean;
}

export interface RuntimePromptSettings {
  revision: number;
  blocks: RuntimePromptBlock[];
  updatedAt: string | null;
}

export interface RuntimeMcpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

export interface RuntimeMcpServer {
  name: string;
  config: RuntimeMcpServerConfig;
  connected: boolean;
  error: string | null;
  tools: Array<{ name: string; description: string }>;
}

export interface RuntimeMcpCatalogServer {
  name: string;
  connected: boolean;
  toolCount: number;
}

export interface RuntimeWebSearchResult {
  provider: RuntimeWebSearchSettings["provider"];
  query: string;
  searchedAt: string;
  citationFormat: "markdown-inline";
  citationInstructions: string;
  results: Array<{ citationId: number; title: string; url: string; snippet: string; publishedAt?: string }>;
}

export interface SessionContextCompression {
  summarized_run_count: number;
  summary: string;
  created_at: string;
}

export interface SessionContextSummary {
  last_input_tokens?: number;
  summarized_run_count: number;
  compressions: SessionContextCompression[];
}

export interface PermissionDecision {
  permission_id: string;
  decision: "approve" | "deny";
  reason?: string;
}

export interface PermissionRequestItem extends Record<string, unknown> {
  id: string;
  type: "permission_request";
  permission_id: string;
  call_id: string;
  prompt: string;
  capability: string;
  resource?: string;
  action?: string;
  denial_reason?: string;
  status: "pending" | "approved" | "denied";
}

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
  permission?: PermissionRequestItem;
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
  | { type: "permission"; key: string; item: PermissionRequestItem }
  | { type: "unknown"; key: string; item: AIUnknownOutputItem };

export type AgentTimelineBlock = AgentOutputBlock;

export type AgentOutputItem = AIResponseOutputItem | PermissionRequestItem;

export interface AgentResponse {
  id: string;
  object: "response";
  session_id: string;
  status: AgentResponseStatus;
  model: string;
  permission_mode?: AgentPermissionMode;
  reasoning_effort?: RuntimeReasoningEffort;
  input: AgentInputMessage[];
  skills: Array<{ id: string; name: string }>;
  output: AgentOutputItem[];
  pending_permission_batch?: PendingPermissionBatch;
  error?: { code: string; message: string };
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface SessionContext {
  session_id: string;
  responses: AgentResponse[];
  context: SessionContextSummary;
}

export interface AgentPermissionEvent extends AIResponseStreamEvent {
  type: "agent.permissions.requested" | "agent.permissions.resolved";
  batch?: PendingPermissionBatch;
  batch_id?: string;
  decisions?: PermissionDecision[];
}

export type RuntimeStreamEvent = AIResponseStreamEvent | AgentPermissionEvent;

export interface RuntimeControlError {
  error: {
    code: string;
    message: string;
    details?: {
      sessionId?: string;
      responseId?: string;
      [key: string]: unknown;
    };
  };
}
