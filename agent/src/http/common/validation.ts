import type { RequestHandler, Response } from "express";
import type { z } from "zod";
import { ApiError, type ValidationApiErrorDetails } from "./api-error.js";

export type ValidationSource = ValidationApiErrorDetails["source"];

type ValidatedValues = Partial<Record<ValidationSource, unknown>>;

export function validate<T extends z.ZodType>(source: ValidationSource, schema: T): RequestHandler {
  return (request, response, next): void => {
    const result = schema.safeParse(request[source]);
    if (!result.success) {
      next(new ApiError(400, "invalid_request", "Request validation failed.", {
        source,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map((part) => typeof part === "symbol" ? part.description ?? part.toString() : part),
          code: issue.code,
          message: issue.message,
        })),
      }));
      return;
    }
    validatedValues(response)[source] = result.data;
    next();
  };
}

export function validated<T>(response: Response, source: ValidationSource): T {
  return validatedValues(response)[source] as T;
}

function validatedValues(response: Response): ValidatedValues {
  const locals = response.locals as { validated?: ValidatedValues };
  locals.validated ??= {};
  return locals.validated;
}
