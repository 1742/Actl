import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { applyAgentTreeSnapshot, applyRuntimeEvent, loadSubagentHistory, resolveAgentPermissionBatch, selectAgentSession, stopAgentResponse } from '../../../src/renderer/src/agent/composables/useAgent';
import { useAgentStore } from '../../../src/renderer/src/agent/stores/agent';
import { localClient } from '../../../src/renderer/src/agent/services/localClient';
import { normalizeResponseContext } from '../../../src/renderer/src/agent/utils/aiResponse';
import type { AgentResponseDto, PendingPermissionBatchDto, AgentStreamEvent } from '../../../src/shared/agent/responses';
import type { SessionContext } from '../../../src/shared/agent/sessions';

const pending = (id: string): PendingPermissionBatchDto => ({
  id, response_id: 'response', created_at: '2026-11-06T00:00:00Z', permissions: [{
    id: `permission-${id}`, response_id: 'response', item_id: `item-${id}`, created_at: '2026-11-06T00:00:00Z',
    tool_call: { id: `call-${id}`, name: 'shell', input: { command: 'echo fixture' } },
    capability: 'process.spawn', prompt: 'Allow fixture', requirement: { capability: 'process.spawn' },
  }],
});
const response = (batch?: PendingPermissionBatchDto): AgentResponseDto => ({
  id: 'response', object: 'response', session_id: 'session', model: 'fixture-model', permission_mode: 'ask', status: batch ? 'waiting_permission' : 'completed',
  input: [], output: batch ? [{ id: `item-${batch.id}`, type: 'permission_request', permission_id: batch.permissions[0]!.id,
    call_id: batch.permissions[0]!.tool_call.id, status: 'pending', capability: 'process.spawn', prompt: 'Allow fixture' }] : [],
  created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:01Z',
  ...(batch ? { pending_permission_batch: batch } : {}),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(id: string) {
  setActivePinia(createPinia());
  Object.assign(globalThis, { window: { actlAgent: { notify: async () => {} } }, localStorage: { setItem() {} } });
  const store = useAgentStore();
  store.setSessions([{ id, runtimeId: 'session', runtimeKind: 'local', title: 'Fixture', created_at: '', updated_at: '' }]);
  store.selectSession(id);
  store.addResponse(id, normalizeResponseContext({ response: response(pending('a')) }));
  store.setActiveResponseId(id, 'response');
  store.setPendingPermissionBatch(id, pending('a'));
  store.setStatus(id, 'waiting_permission');
  return store;
}
const approve = (id: string, batch = 'a') => resolveAgentPermissionBatch([{ permission_id: `permission-${batch}`, decision: 'approve' }], id);

test('tree and request streams deduplicate approval events and reject stale snapshots', () => {
  const id = 'local:session'; const store = setup(id);
  const emit = (event: AgentStreamEvent) => applyRuntimeEvent(id, event);
  emit({ type: 'agent.permissions.requested', response_id: 'response', sequence_number: 3, batch: pending('b') });
  emit({ type: 'agent.permissions.resolved', response_id: 'response', sequence_number: 4,
    decisions: [{ permission_id: 'permission-b', decision: 'approve' }] });
  emit({ type: 'agent.permissions.requested', response_id: 'response', sequence_number: 3, batch: pending('b') });
  assert.equal(store.pendingPermissionBatch, undefined);
  assert.equal(store.status, 'running');
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, members: [{
    session: { id: 'session', rootSessionId: 'session', projectId: null, created_at: '', updated_at: '' },
    response: response(pending('b')), sequenceNumber: 3,
  }] });
  assert.equal(store.pendingPermissionBatch, undefined);
  assert.equal(store.findResponse(id, 'response')?.lastSequenceNumber, 4);
});

test('a delayed tree snapshot cannot replace a newer automatic run', () => {
  const id = 'local:session'; const store = setup(id);
  const newer = { ...response(), id: 'new-response', status: 'in_progress' as const, created_at: '2026-11-06T00:00:03Z' };
  applyRuntimeEvent(id, { type: 'response.created', response_id: newer.id, sequence_number: 0, response: newer });
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, members: [{
    session: { id: 'session', rootSessionId: 'session', projectId: null, created_at: '', updated_at: '' },
    response: response(), sequenceNumber: 10,
  }] });
  assert.equal(store.ensureRuntime(id).activeResponseId, 'new-response');
  assert.equal(store.status, 'running');
});

test('loading subagent history keeps live output and the parent selection', async () => {
  const store = setup('local:session');
  const sessionId = 'local:child';
  const old = { ...response(), id: 'older', session_id: 'child' };
  const live = { ...response(), id: 'live', session_id: 'child', status: 'in_progress' as const };
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, members: [{
    session: { id: 'child', parentSessionId: 'session', rootSessionId: 'session', projectId: null, created_at: '', updated_at: '' },
    response: live, sequenceNumber: 1,
  }] });
  const history = deferred<SessionContext>();
  const originalGet = localClient.getContext;
  localClient.getContext = () => history.promise;
  try {
    const loading = loadSubagentHistory(sessionId, () => true);
    applyRuntimeEvent(sessionId, { type: 'response.output_item.added', response_id: 'live', sequence_number: 2,
      output_index: 0, item: { id: 'live-item', type: 'message', role: 'assistant', status: 'in_progress',
        content: [{ type: 'output_text', text: 'Live text', annotations: [] }] } });
    history.resolve({ session_id: 'child', responses: [old, live], context: { summarized_run_count: 0, compressions: [] } });
    await loading;
    assert.equal(store.selectedSessionId, 'local:session');
    assert.deepEqual(store.ensureRuntime(sessionId).responses.map((context) => context.response.id), ['older', 'live']);
    assert.equal(store.findResponse(sessionId, 'live')?.lastSequenceNumber, 2);
    assert.match(JSON.stringify(store.findResponse(sessionId, 'live')), /Live text/);
  } finally {
    localClient.getContext = originalGet;
  }
});

test('permission stream reply restores the next approval if its last IPC event is absent', async () => {
  const store = setup('reply-fallback');
  const original = localClient.streamPermission;
  localClient.streamPermission = async () => response(pending('b'));
  try {
    await approve('reply-fallback');
    assert.equal(store.pendingPermissionBatch?.id, 'b');
    assert.equal(store.status, 'waiting_permission');
  } finally { localClient.streamPermission = original; }
});

test('a late history snapshot cannot hide an approval that already triggered a notification', async () => {
  const id = 'history-race'; const store = setup(id);
  let notifications = 0;
  window.actlAgent.notify = async () => { notifications++; };
  const history = deferred<SessionContext>(); const stream = deferred<AgentResponseDto>();
  const originalGet = localClient.getContext; const originalStream = localClient.streamPermission;
  let emit!: (event: AgentStreamEvent) => void;
  localClient.getContext = () => history.promise;
  localClient.streamPermission = (...args) => { emit = args[4]; return stream.promise; };
  store.setStatus(id, 'idle');
  const loading = selectAgentSession(id);
  const resuming = approve(id);
  try {
    emit({ type: 'agent.permissions.requested', response_id: 'response', sequence_number: 1, batch: pending('b') });
    assert.equal(store.pendingPermissionBatch?.id, 'b');
    assert.equal(notifications, 1);
    history.resolve({ session_id: 'session', responses: [{ ...response(), status: 'in_progress' }], context: { summarized_run_count: 0, compressions: [] } });
    await loading;
    assert.equal(store.pendingPermissionBatch?.id, 'b');
    assert.equal(store.status, 'waiting_permission');
  } finally {
    stream.resolve(response(pending('b'))); await resuming;
    localClient.getContext = originalGet; localClient.streamPermission = originalStream;
  }
});

test('a completed permission stream clears the approval even without a terminal event', async () => {
  const store = setup('completed-fallback'); const original = localClient.streamPermission;
  localClient.streamPermission = async () => response();
  try {
    await approve('completed-fallback');
    assert.equal(store.pendingPermissionBatch, undefined);
    assert.equal(store.status, 'idle');
  } finally { localClient.streamPermission = original; }
});

test('a reply from an earlier approval cannot replace a newer approval stream', async () => {
  const id = 'stream-owner'; const store = setup(id); const original = localClient.streamPermission;
  const first = deferred<AgentResponseDto>(); const second = deferred<AgentResponseDto>(); let calls = 0;
  localClient.streamPermission = (...args) => {
    const next = ++calls === 1 ? 'b' : 'c';
    args[4]({ type: 'agent.permissions.requested', response_id: 'response', sequence_number: calls, batch: pending(next) });
    return calls === 1 ? first.promise : second.promise;
  };
  const one = approve(id); const two = approve(id, 'b');
  try {
    first.resolve(response(pending('b'))); await one;
    assert.equal(store.pendingPermissionBatch?.id, 'c');
    second.resolve(response(pending('c'))); await two;
    assert.equal(store.pendingPermissionBatch?.id, 'c');
    assert.equal(store.status, 'waiting_permission');
  } finally { first.resolve(response(pending('b'))); second.resolve(response(pending('c'))); await Promise.all([one,two]); localClient.streamPermission = original; }
});

test('cancellation applies the terminal reply and clears the pending approval', async () => {
  const id = 'cancel-reply';
  const store = setup(id);
  const originalCancel = localClient.cancelResponse;
  const completedAt = '2026-11-06T00:00:02Z';
  localClient.cancelResponse = async () => ({
    ...response(), status: 'cancelled', completed_at: completedAt, updated_at: completedAt,
  });
  try {
    const result = await stopAgentResponse(id);
    assert.equal(result.status, 'success');
    assert.equal(store.status, 'idle');
    assert.equal(store.pendingPermissionBatch, undefined);
    assert.equal(store.findResponse(id, 'response')?.response.status, 'cancelled');
    assert.equal(store.findResponse(id, 'response')?.completedAt, completedAt);
  } finally {
    localClient.cancelResponse = originalCancel;
  }
});
