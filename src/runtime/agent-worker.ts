import { loadAppConfig } from '../agent-core/app/config';
import { createAppDependencies } from '../agent-core/app/dependencies';
import { createFileLogger, errorFields } from '../agent-core/observability/logger';
import { runWithRequestContext } from '../agent-core/observability/request-context';
import { AgentApplication } from './agent-application';
import { toApiError } from '../agent-core/contracts/common/api-error';
import type { AgentWorkerRequest, AgentWorkerResponse, AgentResult } from '../shared/agent-ipc';
import type { AgentStreamEvent } from "../shared/agent/responses";
import { z } from 'zod';
import type { Logger } from '../agent-core/observability/logger';
import type { AgentTreeEvent, AgentTreeSnapshot } from '../shared/agent/coordination';

const parent = process.parentPort;
if (!parent) throw new Error('Agent must be launched as an Electron utility process.');
const send = (message: AgentWorkerResponse): void => parent.postMessage(message);
let application: AgentApplication | undefined;
let initializing = false;
let stopping = false;
let logger: Logger | undefined;
const detached = new Set<string>();
const active = new Set<Promise<void>>();
const treeSubscriptions = new Map<string, () => void>();

function failure(error: unknown): AgentResult {
  if (error instanceof z.ZodError) return { ok: false, error: { code: 'invalid_request', message: 'Invalid Agent request.', status: 400,
    details: { source: 'body', issues: error.issues.map((issue) => ({ path: issue.path.map(String), code: issue.code, message: issue.message })) } } };
  const converted = toApiError(error);
  return { ok: false, error: { code: converted.code, message: converted.message, status: converted.status,
    ...(converted.details ? { details: converted.details } : {}) } };
}

parent.on('message', ({ data }: { data: AgentWorkerRequest }) => {
  if (data.type === 'initialize' && !initializing) {
    initializing = true;
    void (async () => {
      try {
        const config = loadAppConfig(data.options.mode, { ACTL_AGENT_HOME: data.options.homeDirectory });
        const activeLogger = await createFileLogger({ directory: config.logDirectory, level: config.logLevel,
          retentionDays: config.logRetentionDays, maxFileSizeBytes: config.logMaxFileSizeBytes });
        logger = activeLogger;
        application = new AgentApplication(await createAppDependencies(config, activeLogger));
        send({ type: 'initialized', result: { ok: true, value: { mode: config.runtimeMode, ownerId: 'developer:local', modelConfigurationEnabled: true } } });
      } catch (error) {
        logger?.error({ event: 'agent.startup_failed', ...errorFields(error) });
        send({ type: 'initialized', result: failure(error) as AgentResult<never> });
      }
    })();
  } else if (data.type === 'request') {
    if (!application || stopping) { send({ type: 'result', id: data.id, result: { ok: false, error: { code: 'runtime_unavailable', message: 'Agent is not ready.' } } }); return; }
    const current = application;
    if (data.command.operation === 'agents.watch') {
      const task = (async () => {
        let root: string | undefined;
        let overflowed = false;
        const buffered: AgentTreeEvent[] = [];
        const off = current.dependencies.agentCoordinator.subscribe((event) => {
          if (!root) {
            if (buffered.length < 256) buffered.push(event);
            else overflowed = true;
            return;
          }
          if ('rootSessionId' in event && event.rootSessionId === root) send({ type: 'tree_event', id: data.id, event });
        });
        treeSubscriptions.set(data.id, off);
        try {
          const snapshot = await current.invoke(data.command) as AgentTreeSnapshot;
          if (treeSubscriptions.get(data.id) !== off) { send({ type: 'result', id: data.id, result: { ok: true, value: null } }); return; }
          root = snapshot.rootSessionId;
          send({ type: 'tree_event', id: data.id, event: { type: 'snapshot', snapshot } });
          for (const event of buffered) if ('rootSessionId' in event && event.rootSessionId === root) send({ type: 'tree_event', id: data.id, event });
          if (overflowed) send({ type: 'tree_event', id: data.id, event: { type: 'changed', rootSessionId: root } });
          send({ type: 'result', id: data.id, result: { ok: true, value: null } });
        } catch (error) { off(); treeSubscriptions.delete(data.id); send({ type: 'result', id: data.id, result: failure(error) }); }
      })();
      active.add(task);
      void task.finally(() => active.delete(task)).catch(() => undefined);
      return;
    }
    const events: AgentStreamEvent[] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (events.length && !detached.has(data.id)) send({ type: 'events', id: data.id, events: events.splice(0) });
      else events.length = 0;
    };
    const onEvent = (event: AgentStreamEvent) => {
      if (detached.has(data.id)) return;
      events.push(event);
      if (events.length >= 64) flush();
      else timer ??= setTimeout(flush, 16);
    };
    const task = runWithRequestContext({ requestId: data.id, ownerId: 'developer:local' }, async () => {
      let result: AgentResult;
      try { result = { ok: true, value: await current.invoke(data.command, data.stream ? onEvent : undefined) }; }
      catch (error) { result = failure(error); }
      flush();
      send({ type: 'result', id: data.id, result });
      detached.delete(data.id);
    });
    active.add(task);
    void task.finally(() => active.delete(task)).catch(() => undefined);
  } else if (data.type === 'detach') {
    const off = treeSubscriptions.get(data.id);
    if (off) { off(); treeSubscriptions.delete(data.id); return; }
    detached.add(data.id);
  } else if (data.type === 'shutdown' && !stopping) {
    stopping = true;
    for (const off of treeSubscriptions.values()) off();
    treeSubscriptions.clear();
    void (async () => {
      try {
        if (application) await application.close(async () => { await Promise.allSettled([...active]); });
        await logger?.close?.();
        send({ type: 'stopped' });
        setImmediate(() => process.exit(0));
      } catch (error) { console.error('Agent shutdown failed:', error instanceof Error ? error.message : 'Unknown error'); process.exit(1); }
    })();
  }
});
send({ type: 'ready' });
