import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { serverNameSchema, serverSchema } from "../../mcp/mcp-config.js";
import type { McpServerManager } from "../../mcp/mcp-server-manager.js";
import { ApiError } from "../common/api-error.js";
import { validate, validated } from "../common/validation.js";

const nameParams = z.object({ name: serverNameSchema }).strict();
const testBody = z.object({ name: serverNameSchema, config: serverSchema }).strict();

export function createMcpRoutes(manager: McpServerManager): Router {
  const routes = Router();
  const safe = (handler: (request: Request, response: Response) => Promise<void> | void) =>
    async (request: Request, response: Response, next: NextFunction) => {
      try { await handler(request, response); } catch (error) { next(error); }
    };

  routes.get("/", safe((_request, response) => {
    response.json({ servers: manager.listServers().map(({ name, connected, error, tools }) => ({ name, connected, error, tools: tools.length })) });
  }));
  routes.get("/servers", safe((_request, response) => {
    response.json({ servers: manager.listServers() });
  }));
  routes.get("/catalog", safe(async (_request, response) => {
    response.json({ servers: await manager.listCatalog() });
  }));
  routes.put("/servers/:name", validate("params", nameParams), validate("body", serverSchema), safe(async (_request, response) => {
    const { name } = validated<z.infer<typeof nameParams>>(response, "params");
    const config = validated<z.infer<typeof serverSchema>>(response, "body");
    try { response.json(await manager.saveServer(name, config)); }
    catch (error) {
      if (error instanceof Error && error.message.includes("collides")) throw new ApiError(409, "mcp_name_collision", error.message);
      throw error;
    }
  }));
  routes.delete("/servers/:name", validate("params", nameParams), safe(async (_request, response) => {
    const { name } = validated<z.infer<typeof nameParams>>(response, "params");
    try { await manager.deleteServer(name); }
    catch (error) {
      if (error instanceof Error && error.message.includes("does not exist")) throw new ApiError(404, "mcp_server_not_found", error.message);
      throw error;
    }
    response.status(204).end();
  }));
  routes.post("/test", validate("body", testBody), safe(async (_request, response) => {
    const { name, config } = validated<z.infer<typeof testBody>>(response, "body");
    try { response.json(await manager.testServer(name, config)); }
    catch (error) {
      throw new ApiError(422, "mcp_connection_failed", error instanceof Error ? error.message : String(error));
    }
  }));
  return routes;
}
