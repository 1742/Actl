import { Router } from "express";
import type { ModelStore } from "../../runtime/model-store.js";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import { validate } from "../common/validation.js";
import { createModelHandlers, modelStoreApiError } from "./model.handlers.js";
import { editModelBodySchema, listModelsQuerySchema, modelParamsSchema, modelPreferenceBodySchema } from "./model.schemas.js";

export function createModelRoutes(store: ModelStore, workspace: WorkspaceStore, storedFiles: StoredFileService): Router {
  const routes = Router();
  const handlers = createModelHandlers(store, workspace, storedFiles);
  const safe = <T extends (...args: never[]) => unknown>(handler: T) => async (...args: Parameters<T>) => {
    try { return await handler(...args); } catch (error) { return modelStoreApiError(error); }
  };
  routes.get("/", validate("query", listModelsQuerySchema), safe(handlers.listModels));
  routes.patch("/:modelTargetId", validate("params", modelParamsSchema), validate("body", editModelBodySchema), safe(handlers.editModel));
  routes.delete("/:modelTargetId", validate("params", modelParamsSchema), safe(handlers.removeModel));
  routes.put("/preference", validate("body", modelPreferenceBodySchema), safe(handlers.setPreference));
  return routes;
}
