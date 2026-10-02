import { Router } from "express";
import { validate } from "../common/validation.js";
import { createSkillHandlers, type SkillHandlerDependencies } from "./skill.handlers.js";
import { listSkillsQuerySchema, skillParamsSchema } from "./skill.schemas.js";

export function createSkillRoutes(dependencies: SkillHandlerDependencies): Router {
  const routes = Router();
  const handlers = createSkillHandlers(dependencies);
  routes.get("/", validate("query", listSkillsQuerySchema), handlers.listSkills);
  routes.get("/:skillId", validate("params", skillParamsSchema), validate("query", listSkillsQuerySchema), handlers.getSkill);
  return routes;
}
