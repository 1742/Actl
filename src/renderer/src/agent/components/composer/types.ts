import type { RuntimeStoredFile } from "../../../../../shared/agent/files";
import type { ResponseInputPartDto } from "../../../../../shared/agent/responses";
import type { PickedFile } from "../../composables/useFileBridge";
import type { AgentRuntimeKind } from "../../services/runtimeClient";

export type AgentComposerNode =
  | { type: "text"; text: string }
  | { type: "skill"; id: string; name: string; scope: string }
  | { type: "mcp_server"; name: string }
  | { type: "workspace_file"; path: string; name: string; workspaceId?: string };

export interface AgentComposerDocument {
  version: 1;
  nodes: AgentComposerNode[];
}

type AgentAttachmentStatus = "pending" | "uploading" | "uploaded" | "error";

export interface AgentComposerAttachment {
  id: string;
  selected: PickedFile;
  status: AgentAttachmentStatus;
  storedFile?: RuntimeStoredFile;
  error?: string;
}

export interface ResolvedAgentComposer {
  content: ResponseInputPartDto[];
  error?: string;
}

export type AgentComposerContextKey = `session:${string}` | `project:${string}:draft` | `standalone:${AgentRuntimeKind}:draft`;
