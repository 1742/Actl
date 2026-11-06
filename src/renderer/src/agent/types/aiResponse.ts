export type AIResponseStatus =
  | "in_progress"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export interface AIResponseError {
  code?: string;
  message: string;
  raw?: unknown;
}

export interface AIResponseUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: Record<string, unknown>;
}

export interface AITextContent {
  type: "input_text" | "output_text" | "summary_text";
  text: string;
  annotations?: unknown[];
  [key: string]: unknown;
}

export interface AIRefusalContent {
  type: "refusal";
  refusal: string;
  [key: string]: unknown;
}

export interface AIFileContent {
  type: "input_file";
  filename?: string;
  file_id?: string;
  file_data?: string;
  file_url?: string;
  bytes?: number;
  mime_type?: string;
  download_url?: string | null;
  preview_url?: string | null;
  preview_src?: string;
  [key: string]: unknown;
}

export interface AIWorkspaceFileContent {
  type: "input_workspace_file";
  path: string;
  [key: string]: unknown;
}

export interface AISkillContent {
  type: "input_skill";
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface AIMcpServerContent {
  type: "input_mcp_server";
  name: string;
  [key: string]: unknown;
}

export type AIResponseContent =
  | AITextContent
  | AIRefusalContent
  | AIFileContent
  | AIWorkspaceFileContent
  | AISkillContent
  | AIMcpServerContent
  | AIUnknownContent;

export interface AIUnknownContent {
  type: string;
  [key: string]: unknown;
}

export interface AIMessageItem {
  type: "message";
  id?: string;
  role: "user" | "assistant" | "system" | "developer";
  status?: string;
  content: AIResponseContent[];
  [key: string]: unknown;
}

export interface AIReasoningItem {
  type: "reasoning";
  id?: string;
  status?: string;
  summary: AIResponseContent[];
  content: AIResponseContent[];
  [key: string]: unknown;
}

export interface AIFunctionCallItem {
  type: "function_call";
  id?: string;
  call_id?: string;
  name: string;
  arguments: string;
  status?: string;
  [key: string]: unknown;
}

export interface AIFunctionCallOutputItem {
  type: "function_call_output";
  id?: string;
  call_id?: string;
  output: unknown;
  status?: string;
  [key: string]: unknown;
}

export interface AIWebSearchCallItem {
  type: "web_search_call";
  id?: string;
  status?: string;
  action: {
    type: "search" | "open_page" | "find_in_page";
    queries?: string[];
    url?: string;
    pattern?: string;
    sources?: Array<{ type: "url"; url: string }>;
  };
  [key: string]: unknown;
}

export interface AIUnknownOutputItem {
  type: string;
  id?: string;
  raw: Record<string, unknown>;
  [key: string]: unknown;
}

export type AIResponseInputItem = AIMessageItem | AIFunctionCallOutputItem | AIUnknownOutputItem;
export type AIResponseOutputItem =
  | AIMessageItem
  | AIReasoningItem
  | AIFunctionCallItem
  | AIFunctionCallOutputItem
  | AIWebSearchCallItem
  | AIUnknownOutputItem;

export interface AIResponse {
  id: string;
  object: "response";
  status: AIResponseStatus;
  model?: string;
  previousResponseId?: string;
  output: AIResponseOutputItem[];
  error?: AIResponseError;
  incompleteDetails?: unknown;
  usage?: AIResponseUsage;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface AIResponseContext {
  sessionId: string;
  input: AIResponseInputItem[];
  response: AIResponse;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Latest applied SSE sequence; used only to make stream replay idempotent. */
  lastSequenceNumber?: number;
}

export interface AIResponseStreamEvent extends Record<string, unknown> {
  type: string;
  response_id?: string;
  response?: unknown;
  sequence_number?: number;
}
