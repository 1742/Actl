import path from "node:path";
import pino from "pino";
import pinoRoll from "pino-roll";
import { getRequestContext } from "./request-context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export interface FileLoggerOptions {
  directory: string;
  level: LogLevel;
  retentionDays: number;
  maxFileSizeBytes: number;
}

export async function createFileLogger(options: FileLoggerOptions): Promise<Logger> {
  const transport = await pinoRoll({
    file: path.join(options.directory, "actl.ndjson"),
    extension: ".ndjson",
    frequency: "daily",
    size: `${Math.max(1, Math.floor(options.maxFileSizeBytes / (1024 * 1024)))}m`,
    mkdir: true,
    limit: { count: Math.max(0, options.retentionDays - 1), removeOtherLogFiles: true },
  });
  const destination = pino({ level: options.level, base: null, timestamp: pino.stdTimeFunctions.isoTime }, transport);
  return wrap(destination);
}

export function createSilentLogger(): Logger {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop };
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      error: sanitize({ type: error.name, message: error.message, stack: error.stack }),
    };
  }
  return { error: sanitize({ type: typeof error, message: String(error) }) };
}

function wrap(destination: pino.Logger): Logger {
  return {
    debug: (fields) => destination.debug(withContext(fields)),
    info: (fields) => destination.info(withContext(fields)),
    warn: (fields) => destination.warn(withContext(fields)),
    error: (fields) => destination.error(withContext(fields)),
  };
}

function withContext(fields: LogFields): LogFields {
  return sanitize({ ...getRequestContext(), ...fields }) as LogFields;
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /api[_-]?key|authorization|cookie|password|secret|token/i.test(key) ? "[REDACTED]" : sanitize(child),
    ]));
  }
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]+)/g, "[REDACTED]");
  }
  return value;
}
