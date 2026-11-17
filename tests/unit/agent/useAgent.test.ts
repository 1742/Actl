import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { applyAgentTreeSnapshot, applyRuntimeEvent, loadSubagentHistory, resolveAgentPermissionBatch, selectAgentSession, stopAgentResponse } from '../../../src/renderer/src/agent/composables/useAgent';
import { useAgentStore } from '../../../src/renderer/src/agent/stores/agent';
import { localClient } from '../../../src/renderer/src/agent/services/localClient';
import { conversationMessageKind, isMessageItem, normalizeResponseContext, subagentRunContexts } from '../../../src/renderer/src/agent/utils/aiResponse';
import { buildAgentOutputGroups } from '../../../src/renderer/src/agent/utils';
import { agentTeamCard, agentTeamCardKind } from '../../../src/renderer/src/agent/utils/agentTeamCards';
import type { AgentResponseDto, PendingPermissionBatchDto, AgentStreamEvent, ResponseMessageItemDto } from '../../../src/shared/agent/responses';
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

function toolCard(name: string, output: unknown) {
  const kind = agentTeamCardKind(name);
  assert.ok(kind);
  const card = agentTeamCard({
    type: 'tool', key: name, call: { type: 'function_call', name, arguments: '{}' },
    presentation: 'agent_team', arguments: {}, status: 'success', result: { ok: true, output, raw: output },
  }, kind);
  assert.ok(card);
  return card;
}

test('team tool cards select readable fields from results', () => {
  const role = toolCard('list_agent_profiles', [{ name: 'Review', id: 'review', description: 'Find regressions', internal: 'hidden' }]);
  assert.deepEqual(role.rows[0], { title: 'Review', reference: 'review', body: 'Find regressions' });
  const agents = toolCard('agents', [
    { title: 'Reviewer', agent: '@a-review', role: 'review', status: 'waiting', currentTask: '#2', recentActivity: { run: 'hidden' } },
    { agent: '@root', role: 'general', status: 'idle', currentTask: null },
  ]);
  assert.equal(agents.rows[0]?.title, 'Reviewer');
  assert.equal(agents.rows[0]?.reference, '@a-review');
  assert.equal(agents.rows[0]?.status?.tone, 'warning');
  assert.deepEqual(agents.rows[0]?.fields?.map(({ value }) => value), ['review', '#2']);
  assert.equal(agents.rows[1]?.title, '@root');
  assert.ok(toolCard('agents', []).empty);
  const plan = toolCard('plan', { revision: 3, items: [{ id: 'hidden', text: 'Review changes', status: 'completed' }] });
  assert.equal(plan.rows[0]?.title, 'Review changes');
  assert.equal(plan.rows[0]?.status?.tone, 'success');

  const task = { title: 'Review changes', task: '#2', status: 'review_required', reviewer: 'hidden',
    acceptanceCriteria: 'Report regressions', attempt: { agent: '@review', result: { run: 'hidden', output: 'All checks passed.' } } };
  const taskList = toolCard('tasks', [task]);
  const taskDetail = toolCard('tasks', { ...task, attempts: [{ raw: 'hidden' }] });
  assert.equal(taskList.rows[0]?.result, undefined);
  assert.equal(taskDetail.rows[0]?.result, 'All checks passed.');
  assert.ok(taskDetail.rows[0]?.fields?.some(({ value }) => value === 'Report regressions'));
  const delegation = toolCard('delegate_task', { ...task, status: 'assigned' });
  assert.equal(delegation.rows[0]?.fields?.[0]?.value, '@review');
  assert.equal(delegation.rows[0]?.result, undefined);
  assert.equal(toolCard('delegate_task', { ...task, status: 'pending', reason: 'unassigned' }).rows[0]?.status?.tone, 'warning');

  const message = { message: 'm#3', from: '@review', to: '@root', subject: 'Review complete',
    body: 'See the report.', thread: 'hidden', createdAt: 1 };
  const mail = toolCard('mail', [message]);
  assert.equal(mail.rows[0]?.detail, '@review → @root');
  assert.equal(mail.rows[0]?.body, 'See the report.');
  assert.ok(toolCard('mail', []).empty);
  const interrupted = toolCard('wait', { status: 'interrupted', waitingFor: { kind: 'mail', replyTo: 'm#1' },
    messages: [message], deadline: 'hidden' });
  assert.match(interrupted.rows[0]?.detail ?? '', /m#1/);
  assert.equal(interrupted.rows[1]?.title, 'Review complete');
  const matched = toolCard('wait', { status: 'matched', kind: 'run_finished', run: 'hidden', output: 'Done' });
  assert.equal(matched.rows[0]?.result, 'Done');
  for (const card of [role, agents, plan, taskList, taskDetail, delegation, mail, interrupted, matched]) {
    assert.doesNotMatch(JSON.stringify(card), /hidden/);
  }
});

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
    const visible = subagentRunContexts(store.ensureRuntime(sessionId).responses);
    assert.deepEqual(visible.map((context) => context.response.id), ['older', 'live']);
    assert.equal(visible[1]?.response.output[0]?.id, 'live-item');
  } finally {
    localClient.getContext = originalGet;
  }
});

test('conversation uses attribution for agent messages in history and live output', () => {
  const id = 'local:session';
  const store = setup(id);
  const source = { kind: 'agent', relationship: 'child', purpose: 'progress', sessionId: 'child', runId: 'child-run' } as const;
  const incoming: ResponseMessageItemDto = { id: 'peer-message', type: 'message', role: 'user', source, status: 'completed',
    content: [{ type: 'output_text', text: 'Peer progress', annotations: [] }] };
  const started = { ...response(), id: 'collaboration', status: 'in_progress' as const,
    input: [{ type: 'message', role: 'user', source, content: [{ type: 'input_text', text: 'Peer follow-up' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Older human input' }] },
      { type: 'message', role: 'user', source: { kind: 'model', sessionId: 'parent', runId: 'parent-run' },
        content: [{ type: 'input_text', text: 'Older delegation' }] }] } satisfies AgentResponseDto;
  applyRuntimeEvent(id, { type: 'response.created', response_id: started.id, sequence_number: 0, response: started });
  applyRuntimeEvent(id, { type: 'response.output_item.done', response_id: started.id, sequence_number: 1,
    output_index: 0, item: incoming });
  const context = store.findResponse(id, started.id)!;
  assert.deepEqual(context.input.filter(isMessageItem).map(conversationMessageKind), ['agent', 'user', 'agent']);
  const groups = buildAgentOutputGroups(context);
  assert.equal(groups.length, 1);
  const message = groups[0];
  assert.ok(message?.type === 'message');
  assert.deepEqual(message.item.source, source);
  assert.equal(conversationMessageKind(message.item), 'agent');
  assert.equal(message.isFinal, false);

  const replayed = normalizeResponseContext({ response: { ...started, status: 'completed', output: [
    { ...incoming, id: 'final', role: 'assistant', source: { kind: 'model', sessionId: 'session', runId: started.id } },
    { ...incoming, role: 'assistant' },
  ] } });
  const final = buildAgentOutputGroups(replayed).find((group) => group.type === 'message' && group.isFinal);
  assert.equal(final?.key, 'final');
});

test('subagent transcript keeps the run and its activity while hiding incoming messages', () => {
  const message = (id: string, role: ResponseMessageItemDto['role'], text = id): ResponseMessageItemDto => ({
    id, role, type: 'message', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }],
  });
  const history = normalizeResponseContext({
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task instructions' }] }],
    response: {
      ...response(),
      output: [
        message('progress', 'assistant'),
        { id: 'thought', type: 'reasoning', status: 'completed', summary: [] },
        { id: 'tool', type: 'function_call', status: 'completed', call_id: 'call', name: 'wait', arguments: '{}' },
        { id: 'tool-result', type: 'function_call_output', status: 'completed', call_id: 'call', output: '{"ok":true}' },
        { id: 'search', type: 'web_search_call', status: 'completed', action: { type: 'search', queries: ['Actl'] } },
        { ...message('parent-mail', 'user'), source: {
          kind: 'agent', sessionId: 'parent', relationship: 'parent', purpose: 'question', mailNumber: 1, subject: 'Question',
        } },
        { ...message('runtime-note', 'assistant'), source: { kind: 'runtime' } },
        message('system', 'system'),
        message('final', 'assistant'),
      ],
    },
  });
  const pending = normalizeResponseContext({ response: {
    ...response(), id: 'pending', status: 'in_progress', output: [message('empty', 'assistant', '')],
  } });
  const visible = subagentRunContexts([history, pending]);
  assert.deepEqual(visible.map((context) => context.response.id), ['response', 'pending']);
  assert.deepEqual(visible[0]?.input, []);
  assert.deepEqual(visible[0]?.response.output.map((item) => item.id), ['progress', 'thought', 'tool', 'tool-result', 'search', 'final']);
  assert.equal(history.input.length, 1);
  assert.equal(history.response.output.length, 9);
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
