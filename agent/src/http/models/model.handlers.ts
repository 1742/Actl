import type { Response } from "express";
import { currentOwnerId } from "../../auth/runtime-auth.js";
import { findModelCompatibilityIssues } from "../../model/compatibility.js";
import { TEXT_TOOL_CAPABILITIES, type ModelStore } from "../../runtime/model-store.js";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import { ApiError } from "../common/api-error.js";
import { validated } from "../common/validation.js";
import type { EditModelBody, ListModelsQuery, ModelParams, ModelPreferenceBody } from "./model.schemas.js";

export function createModelHandlers(store: ModelStore, workspace: WorkspaceStore, storedFiles: StoredFileService) {
  return {
    async listModels(_request: unknown, response: Response): Promise<void> {
      const ownerId = currentOwnerId(response);
      const query = validated<ListModelsQuery>(response, "query");
      const catalog = await store.list(ownerId);
      if (!query.sessionId) {
        response.json(catalog);
        return;
      }
      const session = await workspace.getSession(query.sessionId, ownerId);
      if (!session) throw new ApiError(404, "session_not_found", "Session not found.");
      const history = workspace.getModelContext(session);
      response.json({
        ...catalog,
        data: await Promise.all(catalog.data.map(async (model) => {
          const transcript = await storedFiles.materializeTranscript(session.id, history, model.capabilities);
          const reasons = findModelCompatibilityIssues(transcript, model.capabilities);
          return { ...model, compatible: reasons.length === 0, incompatibilityReasons: reasons };
        })),
      });
    },
    async editModel(_request: unknown, response: Response): Promise<void> {
      const { modelTargetId } = validated<ModelParams>(response, "params");
      const body = validated<EditModelBody>(response, "body");
      response.json(await store.updateModelTarget(currentOwnerId(response), modelTargetId, {
        ...(body.providerModel !== undefined ? { providerModel: body.providerModel } : {}),
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
        ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      }));
    },
    async removeModel(_request: unknown, response: Response): Promise<void> {
      const { modelTargetId } = validated<ModelParams>(response, "params");
      await store.deleteModelTarget(currentOwnerId(response), modelTargetId);
      response.status(204).send();
    },
    async setPreference(_request: unknown, response: Response): Promise<void> {
      const body = validated<ModelPreferenceBody>(response, "body");
      await store.setPreference(currentOwnerId(response), body.modelTargetId ?? undefined, body.reasoningEffort ?? undefined);
      response.status(204).send();
    },
  };
}

export function modelStoreApiError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = String(error.code);
    const message = String(error.message);
    if (code === "model_target_not_found" || code === "provider_account_not_found") throw new ApiError(404, code, message);
    if (code === "model_target_disabled" || code === "provider_credential_missing") throw new ApiError(409, code, message);
    if (code === "provider_config_invalid" || code === "reasoning_effort_invalid") throw new ApiError(400, code, message);
  }
  throw error;
}

export { TEXT_TOOL_CAPABILITIES };
