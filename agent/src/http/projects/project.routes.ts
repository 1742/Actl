import { Router } from "express";
import { validate } from "../common/validation.js";
import { createProjectHandlers, type ProjectHandlerDependencies } from "./project.handlers.js";
import {
  createProjectBodySchema,
  listProjectDirectoryQuerySchema,
  projectParamsSchema,
  searchProjectFilesQuerySchema,
  updateProjectBodySchema,
} from "./project.schemas.js";

export function createProjectRoutes(dependencies: ProjectHandlerDependencies): Router {
  const routes = Router();
  const handlers = createProjectHandlers(dependencies);

  routes.post("/", validate("body", createProjectBodySchema), handlers.createProject);
  routes.get("/", handlers.listProjects);
  routes.get("/:projectId", validate("params", projectParamsSchema), handlers.getProject);
  routes.patch("/:projectId", validate("params", projectParamsSchema), validate("body", updateProjectBodySchema), handlers.updateProject);
  routes.delete("/:projectId", validate("params", projectParamsSchema), handlers.deleteProject);
  routes.get("/:projectId/sessions", validate("params", projectParamsSchema), handlers.listProjectSessions);
  routes.get(
    "/:projectId/files/search",
    validate("params", projectParamsSchema),
    validate("query", searchProjectFilesQuerySchema),
    handlers.searchProjectFiles,
  );
  routes.get(
    "/:projectId/files/tree",
    validate("params", projectParamsSchema),
    validate("query", listProjectDirectoryQuerySchema),
    handlers.listProjectDirectory,
  );

  return routes;
}
