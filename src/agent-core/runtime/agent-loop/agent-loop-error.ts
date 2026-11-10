export type AgentLoopErrorCode =
  | "active_response_exists"
  | "project_active_response_exists"
  | "skills_invalid"
  | "skill_not_found"
  | "skill_unavailable"
  | "mcp_server_invalid"
  | "mcp_server_not_found"
  | "mcp_server_unavailable"
  | "permission_batch_not_pending"
  | "permission_batch_not_current"
  | "permission_batch_decisions_invalid"
  | "model_incompatible_with_session"
  | "response_not_cancellable";

export class AgentLoopError extends Error {
  constructor(
    readonly code: AgentLoopErrorCode,
    message: string,
    readonly details?: { sessionId: string; responseId: string },
  ) {
    super(message);
  }
}
