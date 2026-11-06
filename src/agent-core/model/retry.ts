/**
 * Retry utility for model API calls.
 *
 * Classifies errors as transient (retryable) or permanent, and provides
 * exponential backoff with jitter so retries don't synchronise into thundering-herd.
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Base delay in milliseconds before the first retry (default 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds (default 30000). */
  maxDelayMs?: number;
  /** Timeout in milliseconds for each individual attempt (default 120000). */
  timeoutMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Normalised error classification used by the retry loop.
 */
export interface ClassifiedError {
  retryable: boolean;
  code: string;
  message: string;
}

/**
 * OpenAI SDK (v4+) surfaces errors under these names / statuses.
 * Heuristic: anything that looks like a network, timeout, rate-limit or
 * server-side (5xx / 529) problem is transient.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof Error)) {
    return { retryable: false, code: "unknown_error", message: String(error) };
  }

  const name = error.constructor?.name ?? "";
  const msg = error.message ?? "";

  // OpenAI SDK v6 uses these error classes:
  //   APIConnectionError, APITimeoutError, RateLimitError,
  //   InternalServerError, ServiceUnavailableError
  if (
    name === "APIConnectionError" ||
    name === "APITimeoutError" ||
    name === "RateLimitError" ||
    name === "InternalServerError" ||
    name === "ServiceUnavailableError"
  ) {
    return { retryable: true, code: name, message: msg };
  }

  // OpenAI SDK v6 sometimes throws plain Error for connection failures.
  // Also covers fetch-level errors like "fetch failed" and "Connection error."
  if (name === "Error" && /connection|timeout|fetch failed|network|ECONN/i.test(msg)) {
    return { retryable: true, code: "connection_error", message: msg };
  }

  // APIError with status >= 500 (includes 529 Overloaded)
  if (name === "APIError" && "status" in error) {
    const status = (error as Record<string, unknown>).status as number;
    if (typeof status === "number" && status >= 500) {
      return { retryable: true, code: `${name}:${status}`, message: msg };
    }
  }

  // Common Node.js network errors (may be wrapped by SDK)
  const lower = msg.toLowerCase();
  const networkPatterns = [
    "econnreset", "etimedout", "econnrefused", "enotfound",
    "enetunreach", "eai_again", "epipe", "socket hang up",
    "read econnreset", "connect etimedout", "network error",
    "tls", "certificate",
  ];
  if (networkPatterns.some((p) => lower.includes(p))) {
    return { retryable: true, code: "network_error", message: msg };
  }

  // Fetch-like errors with status
  if (
    "status" in error &&
    typeof (error as Record<string, unknown>).status === "number"
  ) {
    const status = (error as Record<string, unknown>).status as number;
    if (status === 429 || status >= 500) {
      return { retryable: true, code: `http:${status}`, message: msg };
    }
  }

  // Default: assume permanent
  return { retryable: false, code: name || "unknown", message: msg };
}

/**
 * Execute an async operation with exponential-backoff retry on transient errors.
 *
 * Each attempt is bounded by `config.timeoutMs`.  Between attempts we sleep for
 *   min(baseDelay * 2^attempt, maxDelay) + random jitter (0–25 %).
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Wrap the operation with a timeout
      const result = await withTimeout(operation(attempt), timeout);
      return result;
    } catch (error) {
      lastError = error;
      const classified = classifyError(error);

      if (!classified.retryable || attempt >= maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * 0.25 * Math.random();
      const totalDelay = delay + jitter;

      await sleep(Math.round(totalDelay));
    }
  }

  throw lastError;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "APITimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
