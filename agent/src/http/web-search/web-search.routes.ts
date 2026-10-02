import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { currentOwnerId } from "../../auth/runtime-auth.js";
import type { WebSearchService } from "../../web-search/search-service.js";
import { validate, validated } from "../common/validation.js";

const settingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["brave", "tavily", "serper", "bocha"]).optional(),
  mode: z.enum(["auto", "native", "external"]).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).optional(),
}).strict();

type SettingsBody = z.infer<typeof settingsSchema>;

export function createWebSearchRoutes(service: WebSearchService): Router {
  const routes = Router();
  const safe = (handler: (request: Request, response: Response) => Promise<void> | void) => (
    async (request: Request, response: Response, next: NextFunction) => {
      try { await handler(request, response); } catch (error) { next(error); }
    }
  );

  routes.get("/", safe((_request, response) => {
    response.json(service.getSettings(currentOwnerId(response)));
  }));
  routes.put("/", validate("body", settingsSchema), safe(async (_request, response) => {
    const body = validated<SettingsBody>(response, "body");
    response.json(await service.configure(currentOwnerId(response), {
      enabled: body.enabled,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.mode ? { mode: body.mode } : {}),
      ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
    }));
  }));
  routes.delete("/credential", safe(async (_request, response) => {
    response.json(await service.clearCredential(currentOwnerId(response)));
  }));
  routes.post("/test", safe(async (request, response) => {
    response.json(await service.test(currentOwnerId(response), request.signal));
  }));
  return routes;
}
