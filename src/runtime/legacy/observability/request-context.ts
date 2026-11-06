import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
  requestId: string;
  ownerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();
const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(value: string | undefined): string {
  return value && requestIdPattern.test(value) ? value : `req_${randomUUID()}`;
}

export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setRequestOwner(ownerId: string): void {
  const context = storage.getStore();
  if (!context) throw new Error("Request context is unavailable.");
  context.ownerId = ownerId;
}

export function requireRequestOwnerId(): string {
  const ownerId = storage.getStore()?.ownerId;
  if (!ownerId) throw new Error("Request owner is unavailable in the current request.");
  return ownerId;
}
