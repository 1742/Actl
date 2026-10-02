import cors from "cors";
import "dotenv/config";
import express from "express";
import http from "node:http";
import { createApiRouter } from "./http/routes.js";
import { createApiErrorHandler } from "./http/common/api-error.js";
import { createHttpLoggingMiddleware } from "./observability/http-logging.js";
import { createFileLogger, type Logger } from "./observability/logger.js";
import { createRuntimeAuthMiddleware, loadLocalAgentToken } from "./auth/runtime-auth.js";
import { loadAppConfig } from "./app/config.js";
import { createAppDependencies } from "./app/dependencies.js";
import { createDesktopLifecycle } from "./app/desktop-lifecycle.js";

void start();

const REQUEST_TIMEOUT_MS = 10 * 60 * 1_000; // 10-minute global request deadline
const SERVER_KEEP_ALIVE_MS = 5 * 60 * 1_000; // 5-minute keep-alive for idle connections

async function start(): Promise<void> {
  let logger: Logger | undefined;
  try {
    const config = loadAppConfig();
    const { homeDirectory, port } = config;
    const localAgentToken = loadLocalAgentToken();

    const activeLogger = await createFileLogger({
      directory: config.logDirectory,
      level: config.logLevel,
      retentionDays: config.logRetentionDays,
      maxFileSizeBytes: config.logMaxFileSizeBytes,
    });
    logger = activeLogger;

    const dependencies = await createAppDependencies(config, activeLogger);
    const {
      workspaceRepository,
      workspaceStore,
      storedFiles,
      processSupervisor,
      workspaceFiles,
      skillCatalog,
      modelStore,
      webSearchService,
      mcpManager,
      agentLoop,
    } = dependencies;

    let shuttingDown = false;
    const lifecycle = createDesktopLifecycle((reason) => requestShutdown(reason));
    const app = express();
    app.use("/_lifecycle", lifecycle.router);
    app.use((_req, res, next) => {
      if (shuttingDown) res.sendStatus(503);
      else next();
    });
    const runtimeAuth = createRuntimeAuthMiddleware(localAgentToken);
    app.use(cors());
    app.use(createHttpLoggingMiddleware(activeLogger));
    app.use("/prompt-settings", express.json({ limit: "512kb" }));
    app.use(express.json());

    // Global request timeout: abort requests that run longer than 10 minutes.
    // SSE streams send keep-alive comments that reset proxy timeouts; this is a
    // hard server-side safety net for truly hung connections.
    app.use((req, _res, next) => {
      const timer = setTimeout(() => {
        if (!req.destroyed) req.destroy(new Error("Request timeout"));
      }, REQUEST_TIMEOUT_MS);
      req.once("close", () => clearTimeout(timer));
      next();
    });

    app.use(createApiRouter({
      agentLoop,
      skillCatalog,
      workspaceStore,
      modelStore,
      processSupervisor,
      workspaceFiles,
      storedFiles,
      webSearchService,
      mcpManager,
      promptSettingsRepository: workspaceRepository,
      logger: activeLogger,
      runtimeAuth,
    }));
    app.use(createApiErrorHandler(activeLogger));

    const server = http.createServer(app);
    // Allow long-running SSE and model requests without Node closing the socket.
    server.timeout = 0;
    server.keepAliveTimeout = SERVER_KEEP_ALIVE_MS;
    server.headersTimeout = SERVER_KEEP_ALIVE_MS + 5_000;

    server.listen(port, () => {
      lifecycle.start();
      activeLogger.info({ event: "server.started", port, dataDirectory: config.dataDirectory });
    });

    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      lifecycle.stop();
      // A stuck model request or SSE stream must not keep an orphan alive.
      let cleanupCompleted = false;
      const forceExit = setTimeout(() => process.exit(cleanupCompleted ? 0 : 1), 10_000);
      forceExit.unref();
      activeLogger.info({ event: "server.stopping", signal });
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      await agentLoop.cancelAll();
      const cleanup = await Promise.allSettled([
        processSupervisor.dispose(),
        mcpManager.close(),
      ]);
      server.closeAllConnections();
      await serverClosed;
      await storedFiles.cleanupOrphans();
      workspaceRepository.close();
      activeLogger.info({ event: "server.stopped", signal });
      const failed = cleanup.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      // Leave the unref'ed deadline armed for any unrelated lingering handles.
      cleanupCompleted = true;
    };
    const requestShutdown = (signal: string): void => {
      void shutdown(signal).catch((error) => {
        activeLogger.error({ event: "server.stop_failed", signal, error: error instanceof Error ? error.message : String(error) });
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", () => requestShutdown("SIGINT"));
    process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  } catch (error) {
    const failure = { event: "server.start_failed", error: error instanceof Error ? { type: error.name, message: error.message, stack: error.stack } : String(error) };
    if (logger) logger.error(failure);
    else console.error("Actl Agent failed before file logging was initialized:", failure.error);
    process.exitCode = 1;
  }
}
