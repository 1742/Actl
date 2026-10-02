import { Router } from "express";
import type { ModelStore } from "../../runtime/model-store.js";
import { validate } from "../common/validation.js";
import { modelStoreApiError } from "../models/model.handlers.js";
import { createProviderAccountHandlers } from "./provider-account.handlers.js";
import { createModelBodySchema, createProviderAccountBodySchema, editProviderAccountBodySchema, providerAccountParamsSchema, replaceCredentialBodySchema } from "./provider-account.schemas.js";

export function createProviderAccountRoutes(store: ModelStore): Router {
  const routes = Router();
  const handlers = createProviderAccountHandlers(store);
  const safe = <T extends (...args: never[]) => unknown>(handler: T) => async (...args: Parameters<T>) => {
    try { return await handler(...args); } catch (error) { return modelStoreApiError(error); }
  };
  routes.get("/", safe(handlers.list));
  routes.post("/", validate("body", createProviderAccountBodySchema), safe(handlers.create));
  routes.patch("/:accountId", validate("params", providerAccountParamsSchema), validate("body", editProviderAccountBodySchema), safe(handlers.edit));
  routes.put("/:accountId/credential", validate("params", providerAccountParamsSchema), validate("body", replaceCredentialBodySchema), safe(handlers.replaceCredential));
  routes.delete("/:accountId/credential", validate("params", providerAccountParamsSchema), safe(handlers.clearCredential));
  routes.delete("/:accountId", validate("params", providerAccountParamsSchema), safe(handlers.remove));
  routes.post("/:accountId/models", validate("params", providerAccountParamsSchema), validate("body", createModelBodySchema), safe(handlers.createModel));
  return routes;
}
