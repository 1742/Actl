import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, shallowRef } from 'vue';
import { applyAgentTreeSnapshot, applyRuntimeEvent, loadSubagentHistory, resolveAgentPermissionBatch, selectAgentSession, sendAgentMessage, stopAgentResponse } from '../../../src/renderer/src/agent/composables/useAgent';
import { useAgentTree } from '../../../src/renderer/src/agent/composables/useAgentTree';
import { useRunReview } from '../../../src/renderer/src/agent/components/review/useRunReview';
import { useFileChanges } from '../../../src/renderer/src/agent/components/review/useFileChanges';
import { useAgentStore } from '../../../src/renderer/src/agent/stores/agent';
import { localClient } from '../../../src/renderer/src/agent/services/localClient';
import { conversationMessageKind, isMessageItem, normalizeResponseContext, subagentRunContexts } from '../../../src/renderer/src/agent/utils/aiResponse';
import { buildAgentOutputGroups } from '../../../src/renderer/src/agent/utils';
import { agentTeamCard, agentTeamCardKind } from '../../../src/renderer/src/agent/utils/agentTeamCards';
import type { AgentResponseDto, PendingPermissionBatchDto, AgentStreamEvent, ResponseMessageItemDto } from '../../../src/shared/agent/responses';
import type { AgentSession, SessionContext } from '../../../src/shared/agent/sessions';

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
  store.upsertSession({ id, runtimeId: 'session', runtimeKind: 'local', projectId: null, runtimeProjectId: null,
    title: 'Fixture', created_at: '', updated_at: '' });
  store.selectSession(id);
  store.addResponse(id, normalizeResponseContext({ response: response(pending('a')) }));
  store.setActiveResponseId(id, 'response');
  store.setPendingPermissionBatch(id, pending('a'));
  store.setStatus(id, 'waiting_permission');
  return store;
}
const approve = (id: string, batch = 'a', responseId = 'response') => resolveAgentPermissionBatch(
  { sessionId: id, responseId, batchId: batch }, [{ permission_id: `permission-${batch}`, decision: 'approve' }],
);

for (const projectId of [undefined, 'project'] as const) {
  test(`first send from a ${projectId ? 'project' : 'standalone'} draft registers the new tree before streaming`, async (t) => {
    setActivePinia(createPinia());
    Object.assign(globalThis, {
      window: { actlAgent: {
        watchTree: async () => ({ ok: true, value: undefined }),
        onTreeEvents: () => () => {},
        detach: () => {},
      } },
    });
    const store = useAgentStore();
    if (projectId) {
      store.setProjects([{
        id: 'local:project', runtimeId: projectId, runtimeKind: 'local', cwd: 'D:/project',
        workspaces: [], primaryWorkspaceId: '', created_at: '', updated_at: '',
      }]);
      store.startDraft('local:project');
    }
    store.selectedModel = 'fixture-model';
    const rawId = 'new-session';
    const sessionId = `local:${rawId}`;
    const created: AgentSession = { id: rawId, rootSessionId: rawId, projectId: projectId ?? null, created_at: '', updated_at: '' };
    const content = [{ type: 'input_text' as const, text: 'First message' }];
    const completed = { ...response(), session_id: rawId, input: [{ type: 'message' as const, role: 'user' as const, content }] };
    const create = t.mock.method(localClient, 'createSession', async () => created);
    const stream = t.mock.method(localClient, 'streamResponse', async (target, _model, input, _effort, _mode, emit) => {
      assert.equal(target, rawId);
      assert.deepEqual(input, content);
      assert.equal(store.selectedSessionId, sessionId);
      assert.equal(store.currentTree?.members[sessionId]?.runtime.status, 'running');
      emit({ type: 'response.created', response_id: completed.id, sequence_number: 0,
        response: { ...completed, status: 'in_progress' } });
      return completed;
    });
    t.mock.method(localClient, 'getContext', async () => ({
      session_id: rawId, responses: [completed], context: { summarized_run_count: 0, compressions: [] },
    }));
    t.mock.method(localClient, 'renameSession', async (_id, title) => ({ ...created, title: title ?? undefined }));
    const scope = effectScope();
    try {
      scope.run(useAgentTree);
      assert.deepEqual(await sendAgentMessage(content), { status: 'success', data: { sessionId } });
      assert.deepEqual(create.mock.calls.map(({ arguments: args }) => args), [[projectId]]);
      assert.equal(stream.mock.callCount(), 1);
      assert.equal(store.session?.title, 'First message');
      assert.deepEqual(store.responses.map((context) => context.response.id), [completed.id]);
    } finally {
      scope.stop();
    }
  });
}

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
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, childRunResults: [], members: [{
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
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, childRunResults: [], members: [{
    session: { id: 'session', rootSessionId: 'session', projectId: null, created_at: '', updated_at: '' },
    response: response(), sequenceNumber: 10,
  }] });
  assert.equal(store.ensureRuntime(id).activeResponseId, 'new-response');
  assert.equal(store.status, 'running');
});

test('the parent collects sibling approvals and an approval only resumes its own run', async () => {
  const root = 'local:session';
  const store = setup(root);
  const member = (id: string, rootId: string, run: AgentResponseDto) => ({
    session: { id, projectId: null, rootSessionId: rootId,
      ...(id === rootId ? {} : { parentSessionId: rootId }), title: id, created_at: '', updated_at: '' },
    response: { ...run, session_id: id }, sequenceNumber: 1,
  });
  const plan = { revision: 0, items: [] };
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan, childRunResults: [], members: [
    member('session', 'session', { ...response(), status: 'in_progress' }),
    member('first', 'session', response(pending('first'))),
    member('second', 'session', response(pending('second'))),
  ] });
  applyAgentTreeSnapshot({ rootSessionId: 'other', plan, childRunResults: [], members: [
    member('other', 'other', response(pending('other'))),
  ] });
  assert.equal(Object.keys(store.trees).length, 2);
  assert.deepEqual(store.permissionRequests.map(({ sessionId }) => sessionId), ['local:first', 'local:second']);
  const original = localClient.streamPermission;
  let resumes = 0;
  localClient.streamPermission = async (sessionId, responseId, batchId) => {
    resumes++;
    assert.deepEqual([sessionId, responseId, batchId], ['second', 'response', 'second']);
    return { ...response(), session_id: sessionId };
  };
  try {
    assert.equal((await approve('local:second', 'second', 'stale-run')).status, 'error');
    assert.equal((await approve('local:second', 'first')).status, 'error');
    assert.equal((await approve('local:second', 'second')).status, 'success');
    assert.equal(resumes, 1);
    assert.equal(store.status, 'running');
    assert.equal(store.selectedSessionId, root);
    assert.deepEqual(store.permissionRequests.map(({ sessionId }) => sessionId), ['local:first']);
  } finally { localClient.streamPermission = original; }
});

test('loading subagent history keeps live output and the parent selection', async () => {
  const store = setup('local:session');
  const sessionId = 'local:child';
  const old = { ...response(), id: 'older', session_id: 'child' };
  const live = { ...response(), id: 'live', session_id: 'child', status: 'in_progress' as const };
  applyAgentTreeSnapshot({ rootSessionId: 'session', plan: { revision: 0, items: [] }, childRunResults: [], members: [{
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

test('parent and later child edits share file rows while retaining both review targets', async (t) => {
  const store = setup('local:session');
  store.upsertSession({
    id: 'local:child', runtimeKind: 'local', runtimeId: 'child', parentSessionId: 'session', rootSessionId: 'session',
    projectId: null, runtimeProjectId: null, created_at: '', updated_at: '',
  });
  const getReview = t.mock.method(localClient, 'getSessionReview', async (id, options) => ({
    runId: options?.runId ?? null,
    files: id === 'session'
      ? [{ id: 'parent-file', path: 'src/main.ts', additions: 2, deletions: 1, unavailable: false }]
      : [
          { id: 'child-file', path: 'SRC/main.ts', additions: 3, deletions: 0, unavailable: false },
          { id: 'other-file', path: 'other.ts', additions: 1, deletions: 0, unavailable: false },
        ],
  }));
  const parent = { sessionId: 'local:session', runId: 'parent-run' };
  const child = { sessionId: 'local:child', runId: 'child-run' };
  const runs = shallowRef([parent]);
  const scope = effectScope();
  try {
    const files = scope.run(() => useFileChanges(() => runs.value))!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(files.value.map(({ path }) => path), ['src/main.ts']);
    runs.value = [parent, child];
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(files.value.map(({ path }) => path), ['src/main.ts', 'other.ts']);
    const shared = files.value[0]!;
    assert.deepEqual([shared.additions, shared.deletions], [5, 1]);
    assert.deepEqual(shared.changes.map(({ target }) => target), [
      { ...parent, fileId: 'parent-file' },
      { ...child, fileId: 'child-file' },
    ]);
    assert.deepEqual(getReview.mock.calls.map((call) => Array.from(call.arguments)), [
      ['session', { runId: 'parent-run' }],
      ['child', { runId: 'child-run' }],
    ]);
  } finally {
    scope.stop();
  }
});

test('a child file selection opens its exact run and diff in the parent sidebar', async (t) => {
  const store = setup('local:session');
  const child = { id: 'child', parentSessionId: 'session', rootSessionId: 'session', projectId: null, created_at: '', updated_at: '' };
  const result = { parentRunId: 'response', runId: 'child-old-run', sessionId: 'child', hasFileChanges: true, searchOutput: [] };
  applyAgentTreeSnapshot({
    rootSessionId: 'session', plan: { revision: 0, items: [] }, childRunResults: [result],
    members: [{ session: child, response: { ...response(), id: 'child-new-run', session_id: child.id } }],
  });
  assert.deepEqual(store.currentTree?.childRunResults, [result]);
  const files = ['other-file', 'selected-file'].map((id) => ({
    id, path: `${id}.txt`, additions: 1, deletions: 0, unavailable: false,
  }));
  const getReview = t.mock.method(localClient, 'getSessionReview', async (_id, options) => ({
    runId: options?.runId ?? 'other-run', files,
    ...(options?.fileId ? { lines: [{ kind: 'added' as const, text: options.fileId, newLine: 1 }] } : {}),
  }));
  const request = shallowRef({ sessionId: 'local:child', runId: result.runId, fileId: 'selected-file' });
  const scope = effectScope();
  try {
    const review = scope.run(() => useRunReview(request))!;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.selectedSessionId, 'local:session');
    assert.equal(review.session.value?.id, 'local:child');
    assert.equal(review.selectedFile.value?.id, 'selected-file');
    assert.deepEqual(review.lines.value, [{ kind: 'added', text: 'selected-file', newLine: 1 }]);
    assert.deepEqual(getReview.mock.calls.map((call) => Array.from(call.arguments)), [
      ['child', { runId: 'child-old-run' }],
      ['child', { runId: 'child-old-run', fileId: 'selected-file' }],
    ]);

    store.upsertSession({ id: 'local:other', runtimeKind: 'local', runtimeId: 'other', projectId: null,
      runtimeProjectId: null, created_at: '', updated_at: '' });
    store.selectSession('local:other');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(review.target.value, undefined);
    assert.equal(review.session.value?.id, 'local:other');
    assert.equal(review.review.value?.runId, 'other-run');
    assert.equal(getReview.mock.calls[2]?.arguments[0], 'other');
  } finally {
    scope.stop();
  }
});

test('conversation uses attribution for agent messages in history and live output', () => {
  const id = 'local:session';
  const store = setup(id);
  const source = { kind: 'agent', relationship: 'child', purpose: 'progress', sessionId: 'child', mailNumber: 1, subject: 'Progress' } as const;
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
  const activity = groups[0];
  assert.ok(activity?.type === 'activity');
  const message = activity.blocks[0];
  assert.ok(message?.type === 'context_message');
  assert.deepEqual(message.item.source, source);
  assert.equal(conversationMessageKind(message.item), 'agent');

  const replayed = normalizeResponseContext({ response: { ...started, status: 'completed', output: [
    { ...incoming, id: 'final', role: 'assistant', source: { kind: 'model', sessionId: 'session', runId: started.id } },
    { ...incoming, role: 'assistant' },
  ] } });
  const final = buildAgentOutputGroups(replayed).find((group) => group.type === 'message' && group.isFinal);
  assert.equal(final?.key, 'final');
});

test('mail and runtime messages stay with the tools of the same run while streaming and in history', () => {
  const call = (id: string, name: string) => ({ id, type: 'function_call' as const, call_id: id, status: 'completed' as const, name, arguments: '{}' });
  const message = (id: string, role: ResponseMessageItemDto['role'], source?: ResponseMessageItemDto['source']): ResponseMessageItemDto => ({
    id, type: 'message', role, ...(source ? { source } : {}), status: 'completed',
    content: [{ type: 'output_text', text: id, annotations: [] }],
  });
  const output = [
    call('wait', 'wait'),
    message('progress', 'user', { kind: 'agent', relationship: 'child', purpose: 'progress', sessionId: 'child', mailNumber: 1, subject: 'Progress' }),
    message('runtime-input', 'user', { kind: 'runtime' }),
    message('runtime-output', 'assistant', { kind: 'runtime' }),
    call('review', 'tasks'),
  ];
  for (const status of ['in_progress', 'completed'] as const) {
    const completed = status === 'completed';
    const context = normalizeResponseContext({ response: {
      ...response(), status, output: completed ? [...output, message('final', 'assistant')] : output,
    } });
    const groups = buildAgentOutputGroups(context);
    assert.equal(groups.length, completed ? 2 : 1);
    const activity = groups[0];
    assert.ok(activity?.type === 'activity');
    assert.deepEqual(activity.blocks.map(({ key, type }) => [key, type]), [
      ['wait', 'tool'], ['progress', 'context_message'], ['runtime-input', 'context_message'],
      ['runtime-output', 'context_message'], ['review', 'tool'],
    ]);
    if (completed) assert.equal(groups[1]?.type === 'message' && groups[1].isFinal, true);
  }
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
