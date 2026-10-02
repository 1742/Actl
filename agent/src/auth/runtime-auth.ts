import { timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { ApiError } from "../http/common/api-error.js";
import { setRequestOwner } from "../observability/request-context.js";

export const AGENT_TOKEN_HEADER = "X-Actl-Agent-Token";
export function loadLocalAgentToken(environment: NodeJS.ProcessEnv = process.env): string {
  const token = environment.ACTL_AGENT_LOCAL_TOKEN;
  if (!token) throw new Error("Missing local Agent token: ACTL_AGENT_LOCAL_TOKEN.");
  return token;
}

export function createRuntimeAuthMiddleware(expectedToken: string): RequestHandler {
  return async (request, response, next): Promise<void> => {
    try {
      if (!validateLocalToken(request.get(AGENT_TOKEN_HEADER), expectedToken)) {
        throw unauthorized("Local Agent token is invalid.");
      }
      response.locals.ownerId = "developer:local";
      setRequestOwner("developer:local");
      next();
    } catch (error) {
      next(error instanceof ApiError ? error : unauthorized("Local Agent authorization failed."));
    }
  };
}

export function currentOwnerId(response: Response): string {
  const ownerId = response.locals.ownerId;
  if (typeof ownerId !== "string" || !ownerId) throw unauthorized("Authenticated owner is unavailable.");
  return ownerId;
}

export function validateLocalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function unauthorized(message: string): ApiError {
  return new ApiError(401, "unauthorized", message);
}
