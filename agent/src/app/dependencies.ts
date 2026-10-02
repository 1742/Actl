import path from "node:path";
import { InMemoryHookEventBus } from "../hooks/event-bus.js";
import { RunPermissionEngine } from "../permissions/engine.js";
import { SqliteWorkspaceRepository } from "../repositories/sqlite-workspace-repository.js";
import { WorkspaceFileService } from "../runtime/workspace-files.js";
import { AgentLoop } from "../runtime/agent-loop/agent-loop.js";
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
import { McpServerManager } from "../mcp/mcp-server-manager.js";
import { PromptCompiler } from "../runtime/prompt-compiler.js";

export interface AppDependencies {
  readonly workspaceRepository: SqliteWorkspaceRepository;
  readonly workspaceStore: WorkspaceStore;
  readonly storedFiles: StoredFileService;
  readonly secretProtector: SecretProtector;
  readonly modelStore: ModelStore;
  readonly processSupervisor: ProcessSupervisor;
  readonly workspaceFiles: WorkspaceFileService;
  readonly toolRegistry: ToolRegistry;
  readonly skillCatalog: SkillCatalog;
  readonly webSearchService: WebSearchService;
  readonly mcpManager: McpServerManager;
  readonly agentLoop: AgentLoop;
}

/** Construct the runtime dependency graph from the resolved application config. */
export async function createAppDependencies(
  config: AppConfig,
  logger: Logger,
): Promise<AppDependencies> {
  const workspaceRepository = new SqliteWorkspaceRepository(
    path.join(config.dataDirectory, "workspace.db"),
  );
  const workspaceStore = new WorkspaceStore(workspaceRepository);
  await workspaceStore.initialize();

  const storedFiles = new StoredFileService(config.dataDirectory, workspaceRepository);
  await storedFiles.initialize();

  const secretProtector = new SecretProtector(
    path.join(config.homeDirectory, "secrets", `${config.runtimeMode}-master-key.bin`),
  );
  await secretProtector.initialize();

  const modelStore = new ModelStore(workspaceRepository, secretProtector, config.runtimeMode);

  const processSupervisor = new ProcessSupervisor({ logger });
  const workspaceFiles = new WorkspaceFileService();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerProvider(new FilesystemToolProvider(undefined, workspaceFiles));

  toolRegistry.registerProvider(new ShellToolProvider(processSupervisor));
  toolRegistry.registerProvider(new StoredFileToolProvider(storedFiles));
  toolRegistry.registerProvider(new ReadImageToolProvider(storedFiles));

  const skillCatalog = new SkillCatalog({ actlHome: config.homeDirectory });
  toolRegistry.registerProvider(new SkillDiscoveryToolProvider(skillCatalog));
  const webSearchService = new WebSearchService(workspaceRepository, secretProtector);
  toolRegistry.registerProvider(new WebSearchToolProvider(webSearchService, workspaceStore));
  const mcpManager = new McpServerManager(config.homeDirectory, workspaceRepository, secretProtector, logger);
  await mcpManager.initialize();
  toolRegistry.registerProvider(mcpManager);

  const promptCompiler = new PromptCompiler(workspaceRepository);

  const agentLoop = new AgentLoop(
    modelStore,
    toolRegistry,
    new RunPermissionEngine(),
    new InMemoryHookEventBus(),
    workspaceStore,
    storedFiles,
    promptCompiler,
    logger,
    skillCatalog,
    webSearchService,
    mcpManager,
  );

  return {
    workspaceRepository,
    workspaceStore,
    storedFiles,
    secretProtector,
    modelStore,
    processSupervisor,
    workspaceFiles,
    toolRegistry,
    skillCatalog,
    webSearchService,
    mcpManager,
    agentLoop,
  };
}
