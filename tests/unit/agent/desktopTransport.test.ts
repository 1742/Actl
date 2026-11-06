import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentCommand, AgentEventBatch, AgentResult } from '../../../src/shared/agent-ipc';
import { desktopStream, RuntimeRequestError } from '../../../src/renderer/src/agent/services/desktopTransport';
import { LocalRuntimeClient } from '../../../src/renderer/src/agent/services/localClient';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent IPC streams isolate event subscriptions and remove listeners on completion', async () => {
  const listeners = new Set<(batch: AgentEventBatch) => void>();
  const requests: Array<{ id: string; reply: ReturnType<typeof deferred<AgentResult>> }> = [];
  Object.assign(globalThis, { window: { actlAgent: {
    onEvents(listener: (batch: AgentEventBatch) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    stream(id: string) { const reply = deferred<AgentResult>(); requests.push({ id, reply }); return reply.promise; },
  } } });
  const first: unknown[] = []; const second: unknown[] = [];
  const one = desktopStream({ operation: 'responses.create' }, (event) => first.push(event));
  const two = desktopStream({ operation: 'responses.create' }, (event) => second.push(event));
  for (const listener of listeners) listener({ subscriptionId: requests[1]!.id, events: ['second-only'] });
  assert.deepEqual(first, []); assert.deepEqual(second, ['second-only']);
  requests[1]!.reply.resolve({ ok: true, value: 'two' });
  assert.equal(await two, 'two'); assert.equal(listeners.size, 1);
  requests[0]!.reply.resolve({ ok: true, value: 'one' });
  assert.equal(await one, 'one'); assert.equal(listeners.size, 0);
});

test('aborting a stream detaches once, rejects promptly and ignores a late reply', async () => {
  const reply = deferred<AgentResult>(); let listeners = 0; const detached: string[] = []; let id = '';
  Object.assign(globalThis, { window: { actlAgent: {
    onEvents() { listeners++; return () => { listeners--; }; },
    stream(subscription: string) { id = subscription; return reply.promise; },
    detach(subscription: string) { detached.push(subscription); },
  } } });
  const controller = new AbortController();
  const running = desktopStream({ operation: 'responses.create' }, () => {}, controller.signal);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  reply.resolve({ ok: true, value: 'late' }); await Promise.resolve();
  assert.deepEqual(detached, [id]); assert.equal(listeners, 0);
});

test('direct IPC preserves raw IDs, normalizes attachments and exposes structured errors', async () => {
  const commands: AgentCommand[] = []; const client = new LocalRuntimeClient();
  Object.assign(globalThis, { window: { actlAgent: {
    request: async (command: AgentCommand) => {
      commands.push(command);
      if (command.operation === 'accounts.list') return { ok: false, error: { code: 'fixture_error', message: 'Expected failure', status: 409, details: { sessionId: 'owner' } } };
      return { ok: true, value: {} };
    },
    onEvents: () => () => {},
    stream: async (_id: string, command: AgentCommand) => { commands.push(command); return { ok: true, value: {} }; },
  } } });
  await client.searchWorkspaceFiles('id/中文?#%', 'a & b', 7);
  assert.deepEqual(commands[0], { operation: 'workspace.search', params: { projectId: 'id/中文?#%' }, query: { q: 'a & b', limit: '7' } });
  await client.streamResponse('session', 'model', [{ type: 'input_file', file_id: 'file', filename: '中文.txt', media_type: 'text/plain', size: 3 }], undefined, 'ask', () => {});
  assert.deepEqual(commands[1], { operation: 'responses.create', params: { sessionId: 'session' }, body: { model: 'model', permissionMode: 'ask', input: [{ type: 'message', role: 'user', content: [{ type: 'input_file', file_id: 'file' }] }] } });
  await assert.rejects(() => client.listProviderAccounts(), (error) => error instanceof RuntimeRequestError && error.code === 'fixture_error' && error.status === 409 && error.details?.sessionId === 'owner');
});
