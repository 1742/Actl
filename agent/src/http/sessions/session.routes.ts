import { Router } from "express";
import { validate } from "../common/validation.js";
import { createSessionHandlers, type SessionHandlerDependencies } from "./session.handlers.js";
import {
  bindSessionBodySchema,
  createResponseBodySchema,
  compactSessionBodySchema,
  createSessionBodySchema,
  listSessionsQuerySchema,
  resolvePermissionsBodySchema,
  responseParamsSchema,
  sessionParamsSchema,
  updateSessionBodySchema,
} from "./session.schemas.js";
import { createStoredFileHandlers } from "../stored-files/stored-file.handlers.js";
import { storedFileParamsSchema } from "../stored-files/stored-file.schemas.js";

export function createSessionRoutes(dependencies: SessionHandlerDependencies): Router {
  const routes = Router();
  const handlers = createSessionHandlers(dependencies);
  const fileHandlers = createStoredFileHandlers(dependencies);

  routes.post("/", validate("body", createSessionBodySchema), handlers.createSession);
  routes.get("/", validate("query", listSessionsQuerySchema), handlers.listSessions);
  routes.get("/:sessionId", validate("params", sessionParamsSchema), handlers.getSession);
  routes.patch("/:sessionId", validate("params", sessionParamsSchema), validate("body", updateSessionBodySchema), handlers.updateSession);
  routes.delete("/:sessionId", validate("params", sessionParamsSchema), handlers.deleteSession);
  routes.put("/:sessionId/project", validate("params", sessionParamsSchema), validate("body", bindSessionBodySchema), handlers.bindSession);
  routes.get("/:sessionId/context", validate("params", sessionParamsSchema), handlers.getSessionContext);
  routes.post("/:sessionId/compact", validate("params", sessionParamsSchema), validate("body", compactSessionBodySchema), handlers.compactSession);
  routes.post("/:sessionId/files", validate("params", sessionParamsSchema), fileHandlers.upload);
  routes.get("/:sessionId/files", validate("params", sessionParamsSchema), fileHandlers.list);
  routes.get("/:sessionId/files/:fileId", validate("params", storedFileParamsSchema), fileHandlers.get);
  routes.get("/:sessionId/files/:fileId/content", validate("params", storedFileParamsSchema), fileHandlers.download);
  routes.post("/:sessionId/responses", validate("params", sessionParamsSchema), validate("body", createResponseBodySchema), handlers.createResponse);
  routes.get("/:sessionId/responses/:responseId", validate("params", responseParamsSchema), handlers.getResponse);
  routes.post("/:sessionId/responses/:responseId/cancel", validate("params", responseParamsSchema), handlers.cancelResponse);
  routes.post(
    "/:sessionId/responses/:responseId/permissions",
    validate("params", responseParamsSchema),
    validate("body", resolvePermissionsBodySchema),
    handlers.resolvePermissions,
  );

  return routes;
}
