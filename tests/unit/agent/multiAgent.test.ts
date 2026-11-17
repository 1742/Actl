import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspaceDatabase } from '../../../src/agent-core/repositories/sqlite/database';
import { SqliteAgentCoordinationRepository } from '../../../src/agent-core/repositories/sqlite/agent-coordination-repository';
import { SqliteModelCatalogRepository } from '../../../src/agent-core/repositories/sqlite/model-catalog-repository';
import { SqliteProjectRepository } from '../../../src/agent-core/repositories/sqlite/project-repository';
import { SqlitePromptSettingsRepository } from '../../../src/agent-core/repositories/sqlite/prompt-settings-repository';
import { SqliteSessionRepository } from '../../../src/agent-core/repositories/sqlite/session-repository';
import { SqliteStoredFileRepository } from '../../../src/agent-core/repositories/sqlite/stored-file-repository';
import { WorkspaceStore } from '../../../src/agent-core/runtime/workspace-store';
import { StoredFileService } from '../../../src/agent-core/stored-files/stored-file-service';
import { ModelStore } from '../../../src/agent-core/runtime/model-store';
import { SecretProtector } from '../../../src/agent-core/security/secret-protector';
import { AgentCoordinator } from '../../../src/agent-core/runtime/multi-agents/agent-coordinator';
import { CoordinationWaits } from '../../../src/agent-core/runtime/multi-agents/coordination-waits';
import { createSilentLogger } from '../../../src/agent-core/observability/logger';
import { ProcessSupervisor } from '../../../src/agent-core/runtime/process/process-supervisor';
import { ToolRegistry } from '../../../src/agent-core/tools/registry';
import { AgentTeamToolProvider } from '../../../src/agent-core/tools/builtin/agent-team';
import { FilesystemToolProvider } from '../../../src/agent-core/tools/builtin/filesystem/provider';
import { ShellToolProvider } from '../../../src/agent-core/tools/builtin/shell';
import { InMemoryHookEventBus } from '../../../src/agent-core/hooks/event-bus';
import { RunPermissionEngine } from '../../../src/agent-core/permissions/engine';
import { PromptCompiler } from '../../../src/agent-core/runtime/prompt-compiler';
import { TEXT_TOOL_CAPABILITIES, type ModelExecutionSnapshot } from '../../../src/agent-core/model/catalog-types';
import type { ModelClient } from '../../../src/agent-core/model/client';
import type { ModelTurnRequest, TranscriptItem } from '../../../src/agent-core/model/types';
import type { AgentRunRecord } from '../../../src/agent-core/runtime/agent-domain';
import type { AgentStreamEvent } from '../../../src/shared/agent/responses';

const owner = 'developer:local';
const snapshot: ModelExecutionSnapshot = { targetId: 'fake', displayName: 'Fake', providerModel: 'fake', accountId: 'fake',
  accountVersion: 1, credentialVersion: 1, baseURL: 'http://127.0.0.1:1', protocol: 'chat_completions', capabilities: TEXT_TOOL_CAPABILITIES };
const text = (value: string): TranscriptItem => ({ type: 'message', id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: value }] });
const call = (name: string, input: unknown, id = randomUUID()): TranscriptItem => ({ type: 'tool_call', id, callId: id, name, argumentsJson: JSON.stringify(input) });
const input = (value: string) => async () => [{ type: 'message' as const, id: randomUUID(), role: 'user' as const, content: [{ type: 'text' as const, text: value }] }];
const isChild = (request: ModelTurnRequest) => request.instructions.includes('You are a read-only child');
const calls = (request: ModelTurnRequest, name: string) => request.transcript.filter((item) => item.type === 'tool_call' && item.name === name);
const options = { model: 'fake', permissionMode: 'ask' as const };

function toolResult(request: ModelTurnRequest, callId: string | undefined) {
  const result = request.transcript.find((item) => item.type === 'tool_result' && item.callId === callId);
  assert.ok(result?.type === 'tool_result');
  const envelope = result.content[0];
  assert.ok(envelope?.type === 'json' && envelope.value && typeof envelope.value === 'object');
  return { result, envelope: envelope.value as { output?: unknown; error?: string } };
}

function toolOutput<T>(request: ModelTurnRequest, name: string): T {
  const { result, envelope } = toolResult(request, calls(request, name).at(-1)?.callId);
  assert.ok(!result.isError && 'output' in envelope, `${name}: ${envelope.error}`);
  return envelope.output as T;
}

const team = (name: string, command: unknown) => call(name, { command });
const taskDraft = (title: string, instructions = 'Inspect the example.') =>
  ({ title, instructions, acceptanceCriteria: 'Report evidence.', type: 'review', autoAssign: false });
const publish = (title: string) => team('tasks', { action: 'publish', ...taskDraft(title) });

function requestText(request: ModelTurnRequest) {
  return request.transcript.filter((item) => item.type === 'message' && item.role === 'user')
    .flatMap((item) => item.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
}

async function until<T>(probe: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const deadline = Date.now() + 6000;
  do {
    const value = await probe();
    if (value) return value;
    await delay(15);
  } while (Date.now() < deadline);
  assert.fail(label);
}

async function fixture(handler: (request: ModelTurnRequest, signal?: AbortSignal) => Promise<TranscriptItem[]>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'actl-multi-'));
  const projectPath = path.join(directory, 'project'); await mkdir(projectPath);
  const database = await openWorkspaceDatabase(path.join(directory, 'workspace.db'));
  const storedFileRepository = new SqliteStoredFileRepository(database);
  const coordination = new SqliteAgentCoordinationRepository(database);
  const makeWorkspace = async () => {
    const workspace = new WorkspaceStore(new SqliteProjectRepository(database),
      new SqliteSessionRepository(database, storedFileRepository), path.join(directory, 'workspaces'));
    await workspace.initialize();
    return workspace;
  };
  let workspace = await makeWorkspace();
  const files = new StoredFileService(directory, storedFileRepository); await files.initialize();
  const models = new ModelStore(new SqliteModelCatalogRepository(database), new SecretProtector(path.join(directory, 'unused-key')), 'development');
  const client: ModelClient = { protocol: 'chat_completions', runTurn: async (request, _onEvent, opts) => ({
    output: await handler(request, opts?.signal), finishReason: 'stop',
  }) };
  models.resolveSnapshot = async () => structuredClone(snapshot);
  models.getClientForSnapshot = async () => client;
  const makeCoordinator = () => {
    const registry = new ToolRegistry();
    registry.registerProvider(new FilesystemToolProvider());
    registry.registerProvider(new ShellToolProvider());
    const coordinator = new AgentCoordinator(workspace, coordination, new ProcessSupervisor(), {
      models, files, toolRegistry: registry, permissions: new RunPermissionEngine(),
      hooks: new InMemoryHookEventBus(), promptCompiler: new PromptCompiler(new SqlitePromptSettingsRepository(database), coordination),
      logger: createSilentLogger(),
    });
    registry.registerProvider(new AgentTeamToolProvider(coordinator));
    return coordinator;
  };
  let coordinator = makeCoordinator();
  const project = await workspace.createProject(owner, { workspacePaths: [projectPath], primaryWorkspacePath: projectPath });
  let root = await workspace.createSession(owner, { projectId: project.id });
  return { directory, projectPath, database, coordination, project,
    get workspace() { return workspace; }, get coordinator() { return coordinator; }, get root() { return root; },
    restart: async () => {
      await coordinator.close();
      workspace = await makeWorkspace();
      root = (await workspace.getSession(root.id, owner))!;
      coordinator = makeCoordinator();
    },
    close: async () => { await coordinator.close(); database.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function childOf(f: Awaited<ReturnType<typeof fixture>>, title: string) {
  return f.workspace.createSession(owner, { projectId: f.project.id, parentSessionId: f.root.id, title,
    profile: { id: 'review', name: 'Review', description: 'Review work.', instructions: 'Report findings.' } });
}

function post(f: Awaited<ReturnType<typeof fixture>>, from: string, to: string, body: string,
  purpose: 'information' | 'question' | 'progress' | 'urgent', replyTo: string | null = null) {
  return f.coordination.sendMail({ rootId: f.root.id, fromSessionId: from, toSessionId: to, subject: body,
    body, purpose, replyTo, author: 'model' }, randomUUID());
}

test('task claims are atomic and results are idempotent per attempt', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const one = await childOf(f, 'one');
    const two = await childOf(f, 'two');
    const root = f.root.id;
    const run1 = await f.workspace.createResponse(one, await input('one')(), snapshot, { permissionMode: 'plan' });
    const run2 = await f.workspace.createResponse(two, await input('two')(), snapshot, { permissionMode: 'plan' });
    const task = f.coordination.createTask(root, root, taskDraft('First'), 'first');
    const dependent = f.coordination.createTask(root, root, { ...taskDraft('Depends on first'), blockedBy: [task.id] }, 'second');
    assert.throws(() => f.coordination.assignTask(root, dependent.id, one.id, { kind: 'claim', runId: run1.id }, 'blocked'), /not|ready/i);
    assert.throws(() => f.coordination.createTask(root, root, { ...taskDraft('Invalid'), blockedBy: ['unknown'] }, 'bad'), /root/i);

    const secondConnection = new DatabaseSync(path.join(f.directory, 'workspace.db'));
    try {
      const second = new SqliteAgentCoordinationRepository(secondConnection);
      const attempts = await Promise.allSettled([
        Promise.resolve().then(() => f.coordination.assignTask(root, task.id, one.id, { kind: 'claim', runId: run1.id }, 'claim-1')),
        Promise.resolve().then(() => second.assignTask(root, task.id, two.id, { kind: 'claim', runId: run2.id }, 'claim-2')),
      ]);
      assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    } finally { secondConnection.close(); }

    const plan = f.coordination.updatePlan(root, 0, [{ id: 'a', text: 'Check', status: 'pending' }]);
    f.coordination.updatePlan(root, plan.revision, []);
    assert.equal(f.coordination.task(root, task.id)?.status, 'running');
    run1.status = 'completed'; run1.finalOutput = 'first findings';
    await f.workspace.touch(one, run1);
    f.coordination.finishRun(run1.id);
    f.coordination.finishRun(run1.id);
    const submitted = f.coordination.task(root, task.id)!;
    assert.equal(submitted.status, 'review_required');
    assert.equal(submitted.attempt?.result?.output, 'first findings');
    assert.equal(f.coordination.reviewNotifications(root).length, 1);
    assert.equal(f.coordination.task(root, dependent.id)?.ready, false);
    assert.throws(() => f.coordination.decideTask(root, task.id, two.id, { kind: 'accept' }), /authorized reviewer/);
    f.coordination.decideTask(root, task.id, root, { kind: 'reject', reason: 'Get more evidence.' });
    const newRun = await f.workspace.createResponse(one, await input('retry')(), snapshot, { permissionMode: 'plan' });
    f.coordination.assignTask(root, task.id, one.id, { kind: 'claim', runId: newRun.id }, 'reclaim');
    f.coordination.finishRun(run1.id);
    assert.equal(f.coordination.task(root, task.id)?.status, 'running');
    newRun.status = 'completed'; newRun.finalOutput = 'more evidence';
    await f.workspace.touch(one, newRun);
    f.coordination.finishRun(newRun.id);
    const history = f.coordination.attemptHistory(root, task.id);
    assert.deepEqual(history.map((attempt) => [attempt.outcome, attempt.result?.output]), [
      ['rejected', 'first findings'], ['submitted', 'more evidence'],
    ]);
    assert.equal(history[0]?.reason, 'Get more evidence.');
    assert.equal(f.coordination.decideTask(root, task.id, root, { kind: 'accept' }).status, 'completed');
    assert.equal(f.coordination.task(root, dependent.id)?.ready, true);
  } finally { await f.close(); }
});

test('an expired attempt can be retried and its late final cannot replace the new attempt', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const root = f.root.id;
    const oldAgent = await childOf(f, 'Old agent');
    const newAgent = await childOf(f, 'New agent');
    const task = f.coordination.createTask(root, root, taskDraft('Retry'), 'create');
    const first = await f.workspace.createResponse(oldAgent, await input('old')(), snapshot, { permissionMode: 'plan' });
    const stale = f.coordination.assignTask(root, task.id, oldAgent.id, { kind: 'claim', runId: first.id }, 'old');
    const at = Date.now();
    f.database.prepare('UPDATE agent_task_attempts SET lease_expires_at = ? WHERE id = ?').run(at - 1, stale.attempt!.id);
    assert.deepEqual(f.coordination.expiredAttempts(root, at), [stale.attempt!.id]);
    f.coordination.failAttempt(stale.attempt!.id, 'Lease expired.');
    assert.equal(f.coordination.task(root, task.id)?.status, 'failed');
    f.coordination.decideTask(root, task.id, root, { kind: 'retry' }, 'retry');
    const resumed = await f.workspace.createResponse(newAgent, await input('new')(), snapshot, { permissionMode: 'plan' });
    const active = f.coordination.assignTask(root, task.id, newAgent.id, { kind: 'claim', runId: resumed.id }, 'new');
    // Replaying the old retry while the replacement runs must be harmless.
    f.coordination.decideTask(root, task.id, root, { kind: 'retry' }, 'retry');
    first.status = 'completed'; first.finalOutput = 'Late result';
    await f.workspace.touch(oldAgent, first);
    f.coordination.finishRun(first.id);
    assert.deepEqual(f.coordination.task(root, task.id)?.attempt, active.attempt);
    assert.equal(f.coordination.attemptHistory(root, task.id)[0]?.result, undefined);
    resumed.status = 'completed'; resumed.finalOutput = 'Replacement result';
    await f.workspace.touch(newAgent, resumed);
    f.coordination.finishRun(resumed.id);
    assert.equal(f.coordination.task(root, task.id)?.attempt?.result?.output, 'Replacement result');
  } finally { await f.close(); }
});

test('deleting a child with a submitted result keeps the task retryable', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const child = await childOf(f, 'Deleted reviewer');
    const task = f.coordination.createTask(f.root.id, f.root.id, taskDraft('Needs another reviewer'), 'create');
    const run = await f.workspace.createResponse(child, await input('old')(), snapshot, { permissionMode: 'plan' });
    f.coordination.assignTask(f.root.id, task.id, child.id, { kind: 'claim', runId: run.id }, 'claim');
    run.status = 'completed'; run.finalOutput = 'Result';
    await f.workspace.touch(child, run);
    f.coordination.finishRun(run.id);
    await f.coordinator.deleteSession(child);
    assert.equal(f.coordination.task(f.root.id, task.id)?.status, 'failed');
    assert.equal(f.coordination.decideTask(f.root.id, task.id, f.root.id, { kind: 'retry' }).status, 'pending');
  } finally { await f.close(); }
});

test('tools publish, delegate and wait for review in the original root run', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      assert.ok(!request.tools.some(({ name }) => ['shell', 'write_file', 'delegate_task', 'call_mcp_tool'].includes(name)));
      assert.match(request.instructions, /Your current task #1/);
      if (!calls(request, 'write_file').length) return [call('write_file', { path: 'forbidden.txt', content: 'must not write' })];
      assert.ok(toolResult(request, calls(request, 'write_file')[0]?.callId).result.isError);
      return [text('Reviewed with evidence.')];
    }
    if (calls(request, 'wait').length) {
      assert.deepEqual(toolOutput(request, 'wait'), { status: 'matched', kind: 'task_state', task: '#1', state: 'review_required' });
      if (calls(request, 'tasks').length === 1) return [team('tasks', { action: 'accept', task: '#1' })];
      assert.equal(toolOutput<{ status: string }>(request, 'tasks').status, 'completed');
      return [text('Accepted')];
    }
    if (!calls(request, 'tasks').length) return [publish('Review')];
    if (!calls(request, 'delegate_task').length) return [call('delegate_task', { task: '#1', target: { kind: 'create', role: 'review' } })];
    return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#1', states: ['review_required'] } })];
  });
  try {
    const events: AgentStreamEvent[] = [];
    const run = await f.coordinator.start(f.root, input('Delegate review'), options, (event) => events.push(event));
    assert.equal(run.status, 'completed');
    assert.deepEqual(f.root.runs.map(({ id }) => id), [run.id]);
    assert.equal(events.filter((event) => event.type === 'response.created').length, 1);
    assert.ok(events.some((event) => event.type === 'agent.tool.completed' && event.result.toolName === 'wait'));
    const task = f.coordination.tasks(f.root.id)[0]!;
    assert.equal(task.status, 'completed');
    assert.equal(task.attempt?.result?.output, 'Reviewed with evidence.');
    await assert.rejects(access(path.join(f.projectPath, 'forbidden.txt')));
    const child = (await f.workspace.getSession(task.attempt!.ownerSessionId))!;
    assert.equal(child.runs.length, 1);
    assert.equal(child.runs[0]!.input[0]?.source?.kind, 'runtime');
    assert.deepEqual(f.coordination.pendingMail(f.root.id), []);
  } finally { await f.close(); }
});

for (const mode of ['automatic reply', 'automatic timeout', 'explicit resume'] as const) {
  test(`interrupted wait preserves its run and deadline with ${mode}`, async () => {
    const interrupted = Promise.withResolvers<void>();
    const continueInterrupted = Promise.withResolvers<void>();
    const f = await fixture(async (request) => {
      if (!isChild(request)) return [text('Root is available.')];
      const waits = calls(request, 'wait');
      if (waits.length > 1) {
        const result = toolOutput<{ status: string; body?: string }>(request, 'wait');
        assert.equal(result.status, mode === 'automatic timeout' ? 'timed_out' : 'matched');
        if (mode !== 'automatic timeout') assert.equal(result.body, 'the needed answer');
        assert.equal(requestText(request).split('unsolicited question').length - 1, 2, 'Subject and body must be delivered just once.');
        assert.doesNotMatch(requestText(request), /the needed answer/, 'The matched mail is delivered through the wait tool.');
        return [text('Task final after ' + mode)];
      }
      if (waits.length) {
        assert.equal(toolOutput<{ status: string }>(request, 'wait').status, 'interrupted');
        assert.match(requestText(request), /unsolicited question/);
        if (calls(request, 'mail').length === 1) {
          return [team('mail', { action: 'reply', body: 'Answered the other question.' })];
        }
        interrupted.resolve();
        await continueInterrupted.promise;
        return mode === 'explicit resume' ? [team('wait', { action: 'resume' })] : [text('Only handled new mail')];
      }
      if (!calls(request, 'mail').length) return [team('mail', { action: 'send', to: '@parent',
        subject: 'Question for parent', body: 'Please clarify.', purpose: 'question' })];
      const question = toolOutput<{ message: string }>(request, 'mail').message;
      return [team('wait', { action: 'start', timeoutMs: mode === 'automatic timeout' ? 2200 : 10000,
        condition: { kind: 'mail', replyTo: question } })];
    });
    try {
      const rootRun = await f.coordinator.start(f.root, input('Begin'), options);
      const task = f.coordination.createTask(f.root.id, f.root.id, taskDraft('Wait on an answer'), 'task');
      const peer = await childOf(f, 'Peer');
      const child = await childOf(f, 'Waiting child');
      f.coordination.assignTask(f.root.id, task.id, child.id, { kind: 'delegate', sourceRunId: rootRun.id }, 'delegate');
      const original = await until(() => f.coordination.wait(child.id), 'Child did not register its wait.');
      const run = child.runs[0]!;
      assert.equal(original.runId, run.id);
      assert.equal(run.status, 'in_progress');
      const foreign = await f.workspace.createSession(owner, { projectId: f.project.id });
      await assert.rejects(f.coordinator.start(foreign, input('Same project during wait'), options), { code: 'project_active_response_exists' });
      const question = f.coordination.searchMail(child.id, { purpose: 'question', limit: 1 })[0]!;
      post(f, peer.id, child.id, 'background progress', 'progress');
      await delay(40);
      assert.equal(f.coordination.wait(child.id)?.interruptedCallId, null);
      assert.equal(run.timeline.filter((item) => item.type === 'tool_result').length, 1);
      post(f, peer.id, child.id, 'unsolicited question', 'question');
      await until(() => Promise.race([interrupted.promise.then(() => true), delay(10).then(() => false)]), 'Child did not handle the interruption.');
      assert.equal(child.runs.length, 1);
      assert.ok(f.coordination.wait(child.id)?.interruptedCallId);
      assert.equal(f.coordination.wait(child.id)?.deadline, original.deadline);

      const answer = () => post(f, f.root.id, child.id, 'the needed answer', 'information', question.id);
      if (mode === 'explicit resume') answer();
      continueInterrupted.resolve();
      if (mode !== 'explicit resume') {
        await until(() => run.timeline.some((item) => item.type === 'tool_call' && item.source === 'runtime') &&
          f.coordination.wait(child.id)?.interruptedCallId === null, 'Runtime did not resume the wait.');
        assert.equal(f.coordination.wait(child.id)?.deadline, original.deadline);
        assert.equal(f.coordination.task(f.root.id, task.id)?.attempt?.result, undefined);
        if (mode === 'automatic reply') answer();
      }
      const result = await until(() => f.coordination.task(f.root.id, task.id)?.attempt?.result, 'No task result after waiting.');
      assert.equal(result.output, 'Task final after ' + mode);
      assert.equal(result.runId, run.id);
      assert.deepEqual(child.runs.map(({ status }) => status), ['completed']);
      const resumes = run.timeline.filter((item) => item.type === 'tool_call' && item.name === 'wait' && item.source === 'runtime');
      assert.equal(resumes.length, mode === 'explicit resume' ? 0 : 1);
      if (resumes[0]?.type === 'tool_call') {
        const id = resumes[0].callId;
        assert.equal(run.timeline.filter((item) => item.type === 'tool_result' && item.callId === id).length, 1);
      }
      assert.equal(f.coordination.wait(child.id), undefined);
      assert.deepEqual(f.coordination.pendingMail(child.id), []);
      if (mode === 'automatic timeout') {
        const late = post(f, f.root.id, child.id, 'late answer', 'information', question.id);
        await delay(40);
        assert.equal(child.runs.length, 1);
        assert.equal(f.coordination.mail(f.root.id, late.id)?.body, 'late answer');
      }
    } finally { continueInterrupted.resolve(); await f.close(); }
  });
}

test('blocked waits occupy all three child slots until one run finishes', async () => {
  const f = await fixture(async (request) => {
    if (!isChild(request) || requestText(request).includes('Begin task #4')) return [text('Done')];
    if (calls(request, 'wait').length) return [text('Released')];
    return [team('wait', { action: 'start', timeoutMs: 20000, condition: { kind: 'mail', from: '@parent' } })];
  });
  try {
    const source = await f.coordinator.start(f.root, input('Start'), options);
    const children = [];
    for (let index = 1; index <= 4; index++) {
      const child = await childOf(f, 'Child ' + index);
      const task = f.coordination.createTask(f.root.id, f.root.id, taskDraft('Work ' + index), 'work-' + index);
      f.coordination.assignTask(f.root.id, task.id, child.id, { kind: 'delegate', sourceRunId: source.id }, 'assign-' + index);
      children.push(child);
    }
    await until(() => children.slice(0, 3).every((child) => f.coordination.wait(child.id)), 'Three children did not enter wait.');
    assert.ok(children.slice(0, 3).every((child) => child.runs[0]?.status === 'in_progress'));
    assert.equal(children[3]!.runs.length, 0);
    post(f, f.root.id, children[0]!.id, 'Release the first child', 'information');
    await until(() => children[3]!.runs[0]?.status === 'completed', 'The fourth child did not receive the released slot.');
    assert.equal(children[0]!.runs.length, 1);
    assert.equal(children[0]!.runs[0]?.status, 'completed');
  } finally { await f.close(); }
});

test('event cursor catches a task transition between the initial check and registration', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const root = f.root.id;
    const member = await childOf(f, 'Reviewer');
    const task = f.coordination.createTask(root, root, taskDraft('Transient state'), 'create');
    const run = await f.workspace.createResponse(member, await input('Worker')(), snapshot, { permissionMode: 'plan' });
    const parentRun = await f.workspace.createResponse(f.root, await input('Parent')(), snapshot, { permissionMode: 'ask' });
    const waits = new CoordinationWaits(f.coordination, f.workspace);
    const wait = { rootId: root, sessionId: root, condition: { kind: 'task_state' as const, task: task.id, states: ['running' as const] },
      cursor: f.coordination.eventCursor(), deadline: Date.now() + 5000, runId: parentRun.id };
    assert.equal(await waits.outcome(wait, true), undefined);
    f.coordination.assignTask(root, task.id, member.id, { kind: 'claim', runId: run.id }, 'claim');
    run.status = 'completed'; run.finalOutput = 'done';
    await f.workspace.touch(member, run);
    f.coordination.finishRun(run.id);
    assert.equal(f.coordination.task(root, task.id)?.status, 'review_required');
    const subscription = f.coordination.registerWait(wait);
    assert.deepEqual(await waits.outcome(subscription), { kind: 'task_state', task: task.id, state: 'running' });
  } finally { await f.close(); }
});

test('restart fails an interrupted runtime run and clears its wait without consuming queued mail', async () => {
  const f = await fixture(async (request) => {
    assert.match(requestText(request), /after recovery/);
    return [text('New turn')];
  });
  try {
    const peer = await childOf(f, 'Sender');
    const root = f.root.id;
    const run = await f.workspace.createResponse(f.root, await input('Original')(), snapshot, { permissionMode: 'ask' });
    f.coordination.registerWait({ rootId: root, sessionId: root, condition: { kind: 'mail', from: peer.id },
      cursor: f.coordination.eventCursor(), deadline: Date.now() + 5000, runId: run.id });
    const queued = post(f, peer.id, root, 'after recovery', 'information');
    await f.restart();
    assert.equal(f.root.runs[0]?.status, 'failed');
    assert.equal(f.root.runs[0]?.error?.code, 'runtime_interrupted');
    assert.equal(f.coordination.wait(root), undefined);
    assert.equal(f.coordination.pendingMail(root)[0]?.id, queued.id);
    assert.equal((await f.coordinator.start(f.root, input('Continue'), options)).status, 'completed');
  } finally { await f.close(); }
});

test('stopping an active wait aborts its tool, clears its wait and releases admission', async () => {
  const f = await fixture(async (request) => {
    if (requestText(request).includes('after stop')) return [text('New turn')];
    return [team('wait', { action: 'start', timeoutMs: 20000, condition: { kind: 'mail' } })];
  });
  try {
    const first = f.coordinator.start(f.root, input('Wait'), options);
    await until(() => f.coordination.wait(f.root.id), 'Wait did not start.');
    await f.coordinator.stopTree(f.root);
    const run = await first;
    assert.equal(run.status, 'cancelled');
    assert.equal(f.coordination.wait(f.root.id), undefined);
    const wait = run.timeline.find((item) => item.type === 'tool_call' && item.name === 'wait');
    assert.ok(wait?.type === 'tool_call');
    assert.ok(run.timeline.some((item) => item.type === 'tool_result' && item.callId === wait.callId && item.isError));
    assert.equal((await f.coordinator.start(f.root, input('after stop'), options)).status, 'completed');
  } finally { await f.close(); }
});

test('automatic assignment uses idle matching agents and reuses sessions for newly ready work', async () => {
  const f = await fixture(async (request) => [text(isChild(request) ? 'Child result' : 'Root')]);
  try {
    await f.coordinator.start(f.root, input('Plan'), options);
    const root = f.root.id;
    const first = f.coordination.createTask(root, root, { ...taskDraft('First'), autoAssign: true }, 'first');
    const second = f.coordination.createTask(root, root, { ...taskDraft('Second'), autoAssign: true, blockedBy: [first.id] }, 'second');
    const general = await f.workspace.createSession(owner, { parentSessionId: root, projectId: f.project.id });
    assert.equal(f.coordination.task(root, first.id)?.status, 'pending');
    const review = await childOf(f, 'Reviewer');
    await until(() => f.coordination.task(root, first.id)?.status === 'review_required', 'The matching reviewer was not assigned.');
    assert.equal(f.coordination.task(root, first.id)?.attempt?.ownerSessionId, review.id);
    assert.equal(f.coordination.task(root, second.id)?.status, 'pending');
    assert.equal(general.runs.length, 0);
    f.coordination.decideTask(root, first.id, root, { kind: 'accept' });
    await until(() => f.coordination.task(root, second.id)?.status === 'review_required', 'The dependency did not unlock scheduling.');
    assert.equal(f.coordination.task(root, second.id)?.attempt?.ownerSessionId, review.id);
    assert.equal(review.runs.length, 2);
  } finally { await f.close(); }
});

test('mail is peer-to-peer within the root with thread search, read markers and duplicate send protection', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const a = await childOf(f, 'A');
    const b = await childOf(f, 'B');
    const foreign = await f.workspace.createSession(owner, { projectId: f.project.id });
    const original = post(f, a.id, b.id, 'Cache invalidation', 'progress');
    const reply = post(f, b.id, a.id, 'Cache fixed', 'information', original.id);
    assert.equal(reply.threadId, original.threadId);
    assert.throws(() => post(f, a.id, foreign.id, 'outside', 'information'), /does not belong/);
    assert.equal(f.coordination.searchMail(b.id, { from: a.id, keyword: 'invalidation', thread: original.threadId, unread: true, limit: 10 })[0]?.id, original.id);
    f.coordination.readMail(b.id, original.id);
    assert.deepEqual(f.coordination.searchMail(b.id, { unread: true, limit: 10 }), []);
    assert.equal(f.coordination.searchMail(a.id, { from: b.id, thread: original.threadId, limit: 10 })[0]?.id, reply.id);
    const message = { rootId: f.root.id, fromSessionId: a.id, toSessionId: b.id, subject: 'Once',
      body: 'Only once', purpose: 'information' as const, replyTo: null, author: 'model' as const };
    assert.equal(f.coordination.sendMail(message, 'dedupe').id, f.coordination.sendMail(message, 'dedupe').id);
    assert.deepEqual(f.coordination.tasks(f.root.id), []);
  } finally { await f.close(); }
});

for (const scope of ['session', 'project'] as const) {
  test(`deleting a ${scope} cancels preparation before removing its data`, { timeout: 5000 }, async () => {
    let preparing!: () => void;
    const entered = new Promise<void>((resolve) => { preparing = resolve; });
    const f = await fixture(async () => [text('must not run')]);
    try {
      const starting = f.coordinator.start(f.root, async (signal) => {
        preparing();
        await delay(3000, undefined, { signal });
        return input('deleted')();
      }, options);
      const cancelled = assert.rejects(starting, { name: 'AbortError' });
      await entered;
      if (scope === 'session') await f.coordinator.deleteSession(f.root);
      else await f.coordinator.deleteProject(f.project.id, owner);
      await cancelled;
      assert.equal(await f.workspace.getSession(f.root.id), undefined);
      assert.equal(f.root.runs.length, 0);
      if (scope === 'session') {
        const next = await f.workspace.createSession(owner, { projectId: f.project.id });
        assert.equal((await f.coordinator.start(next, input('new session'), options)).status, 'completed');
      }
    } finally { await f.close(); }
  });
}

test('approval resume is exclusive and cancellable, then releases project admission', { timeout: 5000 }, async () => {
  let resumed!: () => void;
  const entered = new Promise<void>((resolve) => { resumed = resolve; });
  const f = await fixture(async (request, signal) => {
    if (!calls(request, 'write_file').length) return [call('write_file', { path: 'approved.txt', content: 'ok' })];
    resumed();
    await delay(3000, undefined, { signal });
    return [text('done')];
  });
  try {
    const run = await f.coordinator.start(f.root, input('start'), options);
    assert.equal(run.status, 'waiting_permission');
    const other = await f.workspace.createSession(owner, { projectId: f.project.id });
    await assert.rejects(f.coordinator.start(other, input('blocked'), options), { code: 'project_active_response_exists' });
    const batch = run.pendingToolBatch!;
    const decisions = batch.permissions.map((permission) => ({ permissionId: permission.id, decision: 'approve' as const }));
    const running = f.coordinator.resume(f.root, run, batch.id, decisions);
    await entered;
    await assert.rejects(f.coordinator.resume(f.root, run, batch.id, decisions), { code: 'active_response_exists' });
    await Promise.all([f.coordinator.stopTree(f.root), f.coordinator.stopTree(f.root)]);
    assert.equal((await running).status, 'cancelled');
    assert.equal((await f.coordinator.start(other, input('admitted'), options)).status, 'waiting_permission');
  } finally { await f.close(); }
});

test('closing preserves suspended approvals and does not execute their tools', async () => {
  const f = await fixture(async () => [call('write_file', { path: 'pending.txt', content: 'pending' })]);
  try {
    const run = await f.coordinator.start(f.root, input('start'), options);
    const batch = structuredClone(run.pendingToolBatch);
    assert.equal(run.status, 'waiting_permission');
    await f.coordinator.close();
    assert.equal(run.status, 'waiting_permission');
    assert.deepEqual(run.pendingToolBatch, batch);
    await assert.rejects(access(path.join(f.projectPath, 'pending.txt')));
  } finally { await f.close(); }
});

test('a shell process can be polled across runs only by its owning session', { timeout: 15000 }, async () => {
  let processId = '';
  const f = await fixture(async (request) => {
    if (request.transcript.at(-1)?.type === 'tool_result') return [text('done')];
    const user = request.transcript.findLast((item) => item.type === 'message' && item.role === 'user');
    const command = `"${process.execPath}" -e "console.log(123); setTimeout(() => {}, 1500)"`;
    return user?.type === 'message' && user.content.some((part) => part.type === 'text' && part.text === 'start shell')
      ? [call('shell', { command, yieldTimeMs: 0 })]
      : [call('shell_poll', { processId, waitMs: 5000, waitForExit: true })];
  });
  const toolResult = (run: AgentRunRecord) => {
    const item = run.timeline.findLast((entry) => entry.type === 'tool_result');
    const value = item?.type === 'tool_result' ? item.content[0] : undefined;
    assert.equal(value?.type, 'json');
    return (value as { value: { ok: boolean; error?: string; output?: { processId: string; status: string } } }).value;
  };
  try {
    const launched = await f.coordinator.start(f.root, input('start shell'), { ...options, permissionMode: 'full_access' });
    const result = toolResult(launched);
    assert.equal(result.ok, true);
    assert.equal(result.output?.status, 'running');
    processId = result.output!.processId;
    const other = await f.workspace.createSession(owner, { projectId: f.project.id });
    const foreign = await f.coordinator.start(other, input('poll shell'), options);
    assert.equal(toolResult(foreign).error, 'process_not_found');
    const own = await f.coordinator.start(f.root, input('poll shell'), options);
    assert.equal(toolResult(own).output?.processId, processId);
    assert.equal(toolResult(own).output?.status, 'exited');
  } finally { await f.close(); }
});
