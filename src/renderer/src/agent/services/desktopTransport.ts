import type { AgentCommand, AgentFailure, AgentResult } from '../../../../shared/agent-ipc';

import type { AgentStreamEvent } from "../../../../shared/agent/responses";

interface RuntimeErrorDetails {
  sessionId?: string;
  responseId?: string;
  [key: string]: unknown;
}

export class RuntimeRequestError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly details: RuntimeErrorDetails | undefined;
  constructor(error: AgentFailure) {
    super(error.message); this.name = 'RuntimeRequestError';
    this.code = error.code; this.status = error.status;
    this.details = error.details && typeof error.details === 'object' ? error.details as RuntimeErrorDetails : undefined;
  }
}

export function unwrap<T>(result: AgentResult<T>): T {
  if (!result.ok) throw new RuntimeRequestError(result.error);
  return result.value;
}

export async function desktopRequest<T>(command: AgentCommand): Promise<T> {
  return unwrap(await window.actlAgent.request(command)) as T;
}

export function desktopStream<T>(command: AgentCommand, onEvent: (event: AgentStreamEvent) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { off(); signal?.removeEventListener('abort', abort); };
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); window.actlAgent.detach(id);
      reject(signal?.reason ?? new DOMException('Stream detached.', 'AbortError'));
    };
    const off = window.actlAgent.onEvents((batch) => {
      if (settled || batch.subscriptionId !== id) return;
      try { for (const event of batch.events) onEvent(event); }
      catch (error) { settled = true; cleanup(); window.actlAgent.detach(id); reject(error); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    window.actlAgent.stream(id, command).then((result) => {
      if (settled) return;
      settled = true; cleanup();
      try { resolve(unwrap(result) as T); } catch (error) { reject(error); }
    }, (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}
