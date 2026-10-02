import type { RequestHandler } from "express";
import type { Logger } from "./logger.js";
import { resolveRequestId, runWithRequestContext } from "./request-context.js";

export const REQUEST_ID_HEADER = "X-Request-Id";

export function createHttpLoggingMiddleware(logger: Logger): RequestHandler {
  return (request, response, next): void => {
    const requestId = resolveRequestId(request.get(REQUEST_ID_HEADER) ?? undefined);
    const startedAt = performance.now();
    response.setHeader(REQUEST_ID_HEADER, requestId);
    response.once("finish", () => {
      const fields = {
        event: "http.request.completed",
        requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (response.statusCode >= 500) logger.error(fields);
      else if (response.statusCode >= 400) logger.warn(fields);
      else logger.info(fields);
    });
    runWithRequestContext({ requestId }, next);
  };
}
