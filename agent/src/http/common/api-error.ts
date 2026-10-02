import type { ErrorRequestHandler } from "express";
import { AgentLoopError } from "../../runtime/agent-loop/agent-loop.js";
import { WorkspaceStoreError } from "../../runtime/workspace-store.js";
import { ModelStoreError } from "../../runtime/model-store.js";
import { createSilentLogger, errorFields, type Logger } from "../../observability/logger.js";
import { StoredFileServiceError } from "../../stored-files/stored-file-service.js";
import { UploadReceivingError } from "./receive-upload.js";
import { WorkspaceDirectoryError } from "../../runtime/workspace-files.js";
import { WebSearchServiceError } from "../../web-search/search-service.js";

export interface ValidationApiErrorDetails {
  source: "body" | "params" | "query";
  issues: Array<{
    path: Array<string | number>;
    code: string;
    message: string;
  }>;
}

export interface ActiveResponseApiErrorDetails {
  sessionId: string;
  responseId: string;
}

export type ApiErrorDetails = ValidationApiErrorDetails | ActiveResponseApiErrorDetails;

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetails;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetails,
  ) {
    super(message);
  }
}

const workspaceStoreStatuses = {
  project_already_exists: 409,
  project_cwd_invalid: 400,
  project_not_found: 404,
  session_already_bound: 409,
  session_not_found: 404,
} as const satisfies Record<WorkspaceStoreError["code"], number>;

const agentLoopStatuses = {
  active_response_exists: 409,
  project_active_response_exists: 409,
  skills_invalid: 400,
  skill_not_found: 404,
  skill_unavailable: 409,
  mcp_server_invalid: 400,
  mcp_server_not_found: 404,
  mcp_server_unavailable: 409,
  permission_batch_not_pending: 409,
  permission_batch_not_current: 409,
  permission_batch_decisions_invalid: 400,
  response_not_cancellable: 409,
  model_incompatible_with_session: 409,
} as const satisfies Record<AgentLoopError["code"], number>;

const modelStoreStatuses = {
  model_target_not_found: 404, model_target_disabled: 409, provider_account_not_found: 404,
  provider_credential_missing: 409, reasoning_effort_invalid: 400,
} as const satisfies Record<ModelStoreError["code"], number>;

const storedFileStatuses = {
  invalid_upload: 400,
  file_too_large: 413,
  stored_file_not_found: 404,
  stored_file_session_mismatch: 404,
  too_many_files: 400,
  files_total_too_large: 413,
  unsupported_file_type: 415,
  unsupported_text_encoding: 415,
} as const satisfies Record<StoredFileServiceError["code"], number>;

const uploadReceivingStatuses = {
  invalid_upload: 400,
  file_too_large: 413,
} as const satisfies Record<UploadReceivingError["code"], number>;

const workspaceDirectoryStatuses = {
  workspace_directory_not_found: 404,
  workspace_path_not_directory: 400,
  workspace_path_invalid: 400,
} as const satisfies Record<WorkspaceDirectoryError["code"], number>;

const webSearchStatuses = {
  web_search_disabled: 409,
  web_search_native_unavailable: 409,
  web_search_credential_missing: 409,
  web_search_config_invalid: 400,
  web_search_auth_failed: 400,
  web_search_rate_limited: 429,
  web_search_provider_timeout: 504,
  web_search_provider_unavailable: 502,
} as const satisfies Record<WebSearchServiceError["code"], number>;

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof WorkspaceStoreError) {
    return new ApiError(workspaceStoreStatuses[error.code], error.code, error.message);
  }
  if (error instanceof AgentLoopError) {
    return new ApiError(agentLoopStatuses[error.code], error.code, error.message, error.details);
  }
  if (error instanceof ModelStoreError) return new ApiError(modelStoreStatuses[error.code], error.code, error.message);
  if (error instanceof StoredFileServiceError) {
    return new ApiError(storedFileStatuses[error.code], error.code, error.message);
  }
  if (error instanceof UploadReceivingError) {
    return new ApiError(uploadReceivingStatuses[error.code], error.code, error.message);
  }
  if (error instanceof WorkspaceDirectoryError) {
    return new ApiError(workspaceDirectoryStatuses[error.code], error.code, error.message);
  }
  if (error instanceof WebSearchServiceError) {
    return new ApiError(webSearchStatuses[error.code], error.code, error.message);
  }
  if (isJsonSyntaxError(error)) {
    return new ApiError(400, "invalid_request", "Malformed JSON request body.", {
      source: "body",
      issues: [{ path: [], code: "invalid_json", message: "Request body must contain valid JSON." }],
    });
  }
  return new ApiError(500, "internal_error", "Internal server error.");
}

export function toApiErrorBody(error: unknown): ApiErrorBody {
  const apiError = toApiError(error);
  return {
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
    },
  };
}

export const apiErrorHandler: ErrorRequestHandler = createApiErrorHandler();

export function createApiErrorHandler(logger: Logger = createSilentLogger()): ErrorRequestHandler {
  return (error, _request, response, _next): void => {
    const apiError = toApiError(error);
    if (apiError.status === 500) {
      logger.error({ event: "http.request.failed", statusCode: apiError.status, errorCode: apiError.code, ...errorFields(error) });
    }
    response.status(apiError.status).json(toApiErrorBody(apiError));
  };
}

function isJsonSyntaxError(error: unknown): error is SyntaxError & { body: unknown } {
  return error instanceof SyntaxError && typeof error === "object" && error !== null && "body" in error;
}
