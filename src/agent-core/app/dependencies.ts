import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AgentCoordinator } from '../runtime/multi-agents/agent-coordinator.js';
import { AgentTeamToolProvider } from '../tools/builtin/agent-team.js';
import { InMemoryHookEventBus } from "../hooks/event-bus.js";
import { RunPermissionEngine } from "../permissions/engine.js";
import type { PromptSettingsRepository } from "../repositories/prompt-settings-repository.js";
import { openWorkspaceDatabase } from "../repositories/sqlite/database.js";
import { SqliteAgentCoordinationRepository } from "../repositories/sqlite/agent-coordination-repository.js";
import { SqliteMcpConfigRepository } from "../repositories/sqlite/mcp-config-repository.js";
import { SqliteModelCatalogRepository } from "../repositories/sqlite/model-catalog-repository.js";
import { SqliteProjectRepository } from "../repositories/sqlite/project-repository.js";
import { SqlitePromptSettingsRepository } from "../repositories/sqlite/prompt-settings-repository.js";
import { SqliteSessionRepository } from "../repositories/sqlite/session-repository.js";
import { SqliteStoredFileRepository } from "../repositories/sqlite/stored-file-repository.js";
import { SqliteWebSearchSettingsRepository } from "../repositories/sqlite/web-search-settings-repository.js";
import { WorkspaceFileService } from "../runtime/workspace-files.js";
import { ModelStore } from "../runtime/model-store.js";
import { ProcessSupervisor } from "../runtime/process/process-supervisor.js";
import { WorkspaceStore } from "../runtime/workspace-store.js";
import { ShellToolProvider } from "../tools/builtin/shell.js";
import { FilesystemToolProvider } from "../tools/builtin/filesystem/provider.js";
import { SkillDiscoveryToolProvider } from "../tools/builtin/skill-resources.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  SkillCatalog,
} from "../skills/index.js";
import { StoredFileService } from "../stored-files/stored-file-service.js";
import { StoredFileToolProvider } from "../tools/builtin/stored-files.js";
import { ReadImageToolProvider } from "../tools/builtin/read-image.js";
import { SecretProtector } from "../security/secret-protector.js";
import type { AppConfig } from "./config.js";
import type { Logger } from "../observability/logger.js";
import { WebSearchService } from "../web-search/search-service.js";
import { WebSearchToolProvider } from "../tools/builtin/web-search.js";
import { WebFetchToolProvider } from "../tools/builtin/web-fetch.js";
import { McpServerManager } from "../mcp/mcp-server-manager.js";
import { PromptCompiler } from "../runtime/prompt-compiler.js";

export interface AppDependencies {
  closeDatabase(): void;
  readonly workspaceStore: WorkspaceStore;
  readonly storedFiles: StoredFileService;
  readonly secretProtector: SecretProtector;
  readonly modelStore: ModelStore;
  readonly workspaceFiles: WorkspaceFileService;
  readonly promptSettingsRepository: PromptSettingsRepository;
  readonly skillCatalog: SkillCatalog;
  readonly webSearchService: WebSearchService;
  readonly mcpManager: McpServerManager;
  readonly agentCoordinator: AgentCoordinator;
}

/** Construct the runtime dependency graph from the resolved application config. */
export async function createAppDependencies(
  config: AppConfig,
  logger: Logger,
): Promise<AppDependencies> {
  const database = await openWorkspaceDatabase(path.join(config.dataDirectory, "workspace.db"));
  try {
    return await assembleAppDependencies(config, logger, database);
  } catch (error) {
    database.close();
    throw error;
  }
}

async function assembleAppDependencies(
  config: AppConfig,
  logger: Logger,
  database: DatabaseSync,
): Promise<AppDependencies> {
  const storedFileRepository = new SqliteStoredFileRepository(database);
  const promptSettingsRepository = new SqlitePromptSettingsRepository(database);
  const coordinationRepository = new SqliteAgentCoordinationRepository(database);
  const workspaceStore = new WorkspaceStore(
    new SqliteProjectRepository(database),
    new SqliteSessionRepository(database, storedFileRepository),
    path.join(config.homeDirectory, "workspaces", config.runtimeMode),
  );
  await workspaceStore.initialize();

  const storedFiles = new StoredFileService(config.dataDirectory, storedFileRepository);
  await storedFiles.initialize();

  const secretProtector = new SecretProtector(
    path.join(config.homeDirectory, "secrets", `${config.runtimeMode}-master-key.bin`),
  );
  await secretProtector.initialize();

  const modelStore = new ModelStore(new SqliteModelCatalogRepository(database), secretProtector, config.runtimeMode);

  const processSupervisor = new ProcessSupervisor({ logger });
  const workspaceFiles = new WorkspaceFileService();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerProvider(new FilesystemToolProvider(undefined, workspaceFiles));

  toolRegistry.registerProvider(new ShellToolProvider());
  toolRegistry.registerProvider(new StoredFileToolProvider(storedFiles));
  toolRegistry.registerProvider(new ReadImageToolProvider(storedFiles));

  const skillCatalog = new SkillCatalog({ actlHome: config.homeDirectory });
  toolRegistry.registerProvider(new SkillDiscoveryToolProvider(skillCatalog));
  const webSearchService = new WebSearchService(new SqliteWebSearchSettingsRepository(database), secretProtector);
  toolRegistry.registerProvider(new WebSearchToolProvider(webSearchService, workspaceStore));
  toolRegistry.registerProvider(new WebFetchToolProvider());
  const mcpManager = new McpServerManager(config.homeDirectory, new SqliteMcpConfigRepository(database), secretProtector, logger);
  await mcpManager.initialize();
  toolRegistry.registerProvider(mcpManager);

  const promptCompiler = new PromptCompiler(promptSettingsRepository, coordinationRepository);

  const agentCoordinator = new AgentCoordinator(workspaceStore, coordinationRepository, processSupervisor, {
    models: modelStore,
    files: storedFiles,
    toolRegistry,
    permissions: new RunPermissionEngine(),
    hooks: new InMemoryHookEventBus(),
    promptCompiler,
    logger,
    skills: skillCatalog,
    webSearch: webSearchService,
    mcp: mcpManager,
  });
  toolRegistry.registerProvider(new AgentTeamToolProvider(agentCoordinator));

  return {
    agentCoordinator,
    promptSettingsRepository,
    closeDatabase: () => {
      if (database.isOpen) database.close();
    },
    workspaceStore,
    storedFiles,
    secretProtector,
    modelStore,
    workspaceFiles,
    skillCatalog,
    webSearchService,
    mcpManager,
  };
}
