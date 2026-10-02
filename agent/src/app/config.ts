import path from "node:path";
import type { BuildFlavor } from "../build-info.js";
import { BUILD_FLAVOR } from "../build-info.js";
import type { LogLevel } from "../observability/logger.js";

export type RuntimeMode = BuildFlavor;

export function resolveRuntimeMode(buildFlavor: BuildFlavor, value: string | undefined): RuntimeMode {
  const mode = value ?? buildFlavor;
  if (mode !== "development" && mode !== "release") {
    throw new Error("ACTL_AGENT_RUNTIME_MODE must be development or release.");
  }
  if (buildFlavor === "release" && mode !== "release") {
    throw new Error("The release build does not allow development mode.");
  }
  return mode;
}

export interface AppConfig {
  readonly homeDirectory: string;
  readonly port: number;
  readonly runtimeMode: RuntimeMode;
  readonly dataDirectory: string;
  readonly logDirectory: string;
  readonly logLevel: LogLevel;
  readonly logRetentionDays: number;
  readonly logMaxFileSizeBytes: number;
}

/** Resolve all Agent process configuration in one place. */
export function loadAppConfig(
  buildFlavor: BuildFlavor = BUILD_FLAVOR,
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const homeDirectory = path.resolve(environment.ACTL_AGENT_HOME ?? process.cwd());
  const runtimeMode = resolveRuntimeMode(buildFlavor, environment.ACTL_AGENT_RUNTIME_MODE);
  return {
    homeDirectory,
    port: parsePositiveInteger(environment.ACTL_AGENT_PORT, 3000),
    runtimeMode,
    dataDirectory: path.join(homeDirectory, "database", runtimeMode),
    logDirectory: path.resolve(environment.ACTL_AGENT_LOG_DIR ?? path.join(homeDirectory, "logs")),
    logLevel: parseLogLevel(environment.ACTL_AGENT_LOG_LEVEL),
    logRetentionDays: parsePositiveInteger(environment.ACTL_AGENT_LOG_RETENTION_DAYS, 14),
    logMaxFileSizeBytes: parsePositiveInteger(
      environment.ACTL_AGENT_LOG_MAX_FILE_SIZE,
      50 * 1024 * 1024,
    ),
  };
}

function parseLogLevel(value: string | undefined): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
