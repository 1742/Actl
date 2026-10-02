import { Router, type RequestHandler } from "express";
import type { AgentLoop } from "../runtime/agent-loop/agent-loop.js";
import type { ModelStore } from "../runtime/model-store.js";
import type { ProcessSupervisor } from "../runtime/process/process-supervisor.js";
import type { WorkspaceStore } from "../runtime/workspace-store.js";
import { healthRoutes } from "./health/health.routes.js";
import { createProjectRoutes } from "./projects/project.routes.js";
import { createSessionRoutes } from "./sessions/session.routes.js";
import type { Logger } from "../observability/logger.js";
import { createModelRoutes } from "./models/model.routes.js";
import type { SkillCatalog } from "../skills/index.js";
import { createSkillRoutes } from "./skills/skill.routes.js";
import type { WorkspaceFileService } from "../runtime/workspace-files.js";
import type { StoredFileService } from "../stored-files/stored-file-service.js";
import { createProviderAccountRoutes } from "./provider-accounts/provider-account.routes.js";
import { currentOwnerId } from "../auth/runtime-auth.js";
import type { WebSearchService } from "../web-search/search-service.js";
import { createWebSearchRoutes } from "./web-search/web-search.routes.js";
import type { McpServerManager } from "../mcp/mcp-server-manager.js";
import { createMcpRoutes } from "./mcp/mcp.routes.js";
import type { PromptSettingsRepository } from "../repositories/prompt-settings-repository.js";
import { createPromptSettingsRoutes } from "./prompt-settings/prompt-settings.routes.js";

export interface ApiRouterDependencies {
  agentLoop: AgentLoop;
  skillCatalog: SkillCatalog;
  workspaceStore: WorkspaceStore;
  modelStore: ModelStore;
  processSupervisor: ProcessSupervisor;
  workspaceFiles: WorkspaceFileService;
  storedFiles: StoredFileService;
  webSearchService: WebSearchService;
  mcpManager: McpServerManager;
  promptSettingsRepository: PromptSettingsRepository;
  logger?: Logger;
  runtimeAuth: RequestHandler;
}

export function createApiRouter(dependencies: ApiRouterDependencies): Router {
  const router = Router();
  router.use("/health", healthRoutes);
  router.use(dependencies.runtimeAuth);
  router.get("/runtime", (_request, response) => response.json({
    mode: dependencies.modelStore.mode,
    ownerId: currentOwnerId(response),
    modelConfigurationEnabled: true,
  }));
  router.use("/provider-accounts", createProviderAccountRoutes(dependencies.modelStore));
  router.use("/web-search", createWebSearchRoutes(dependencies.webSearchService));
  router.use("/prompt-settings", createPromptSettingsRoutes(dependencies.promptSettingsRepository));
  router.use("/mcp", createMcpRoutes(dependencies.mcpManager));
  router.use("/models", createModelRoutes(dependencies.modelStore, dependencies.workspaceStore, dependencies.storedFiles));
  router.use("/skills", createSkillRoutes({
    skillCatalog: dependencies.skillCatalog,
    workspaceStore: dependencies.workspaceStore,
  }));
  router.use("/projects", createProjectRoutes({
    agentLoop: dependencies.agentLoop,
    workspaceStore: dependencies.workspaceStore,
    processSupervisor: dependencies.processSupervisor,
    workspaceFiles: dependencies.workspaceFiles,
    storedFiles: dependencies.storedFiles,
  }));
  router.use("/sessions", createSessionRoutes({
    agentLoop: dependencies.agentLoop,
    workspaceStore: dependencies.workspaceStore,
    processSupervisor: dependencies.processSupervisor,
    workspaceFiles: dependencies.workspaceFiles,
    storedFiles: dependencies.storedFiles,
    ...(dependencies.logger ? { logger: dependencies.logger } : {}),
  }));
  return router;
}
