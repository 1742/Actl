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
import { createSilentLogger } from '../../../src/agent-core/observability/logger';
import { ProcessSupervisor } from '../../../src/agent-core/runtime/process/process-supervisor';
import { ToolRegistry } from '../../../src/agent-core/tools/registry';
import { AgentTeamToolProvider } from '../../../src/agent-core/tools/builtin/agent-team';
import { toAgentResponseDto } from '../../../src/agent-core/contracts/agent-responses/presenter';
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

function runTarget(session: { id: string; runs: AgentRunRecord[] }) {
  return { sessionId: session.id, runId: session.runs[0]!.id };
}

async function fixture(handler: (request: ModelTurnRequest, signal?: AbortSignal) => Promise<TranscriptItem[]>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'actl-multi-'));
  const projectPath = path.join(directory, 'project'); await mkdir(projectPath);
  const database = await openWorkspaceDatabase(path.join(directory, 'workspace.db'));
  const storedFileRepository = new SqliteStoredFileRepository(database);
  const coordination = new SqliteAgentCoordinationRepository(database);
  const workspace = new WorkspaceStore(new SqliteProjectRepository(database),
    new SqliteSessionRepository(database, storedFileRepository), path.join(directory, 'workspaces'));
  await workspace.initialize();
  const files = new StoredFileService(directory, storedFileRepository); await files.initialize();
  const models = new ModelStore(new SqliteModelCatalogRepository(database), new SecretProtector(path.join(directory, 'unused-key')), 'development');
  const client: ModelClient = { protocol: 'chat_completions', runTurn: async (request, _onEvent, opts) => ({
    output: await handler(request, opts?.signal), finishReason: 'stop',
  }) };
  models.resolveSnapshot = async () => structuredClone(snapshot);
  models.getClientForSnapshot = async () => client;
  const registry = new ToolRegistry(); registry.registerProvider(new FilesystemToolProvider());
  registry.registerProvider(new ShellToolProvider());
  const processes = new ProcessSupervisor();
  const compiler = new PromptCompiler(new SqlitePromptSettingsRepository(database), coordination);
  const coordinator = new AgentCoordinator(workspace, coordination, processes, {
    models, files, toolRegistry: registry, permissions: new RunPermissionEngine(),
    hooks: new InMemoryHookEventBus(), promptCompiler: compiler, logger: createSilentLogger(),
  });
  registry.registerProvider(new AgentTeamToolProvider(coordinator));
  const project = await workspace.createProject(owner, { workspacePaths: [projectPath], primaryWorkspacePath: projectPath });
  const root = await workspace.createSession(owner, { projectId: project.id });
  return { directory, projectPath, coordination, workspace, files, coordinator, root, project, compiler,
    close: async () => { await coordinator.close(); database.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('migrates v20 without losing sessions, persists plans/messages, and rejects stale plan revisions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'actl-migration-'));
  const dbPath = path.join(directory, 'workspace.db');
  const db = new DatabaseSync(dbPath);
  // The v20 tables used by the migration, before sessions gained coordination columns.
  db.exec(`
    CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL) STRICT;
    CREATE TABLE projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE sessions(
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE agent_runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id));
    CREATE TABLE timeline_items(run_id TEXT, item_order INTEGER NOT NULL, item_id TEXT, item_type TEXT, payload_json TEXT, PRIMARY KEY(run_id, item_order));
  `);
  db.prepare('INSERT INTO schema_metadata VALUES (1, ?, 20, ?)').run('multi-user-multi-model', 'now');
  db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?, ?, ?)').run('root', owner, 'retained', 'now', 'now');
  db.close();
  let database = await openWorkspaceDatabase(dbPath);
  try {
    const sessions = await new SqliteSessionRepository(database, new SqliteStoredFileRepository(database)).listSessions();
    assert.equal(sessions[0]?.rootSessionId, 'root');
    assert.equal(sessions[0]?.title, 'retained');
    const coordination = new SqliteAgentCoordinationRepository(database);
    coordination.updatePlan('root', 0, [{ id: 'a', text: 'Inspect', status: 'pending' }]);
    assert.throws(() => coordination.updatePlan('root', 0, []), /revision/);
    assert.equal(coordination.updatePlan('root', 1, [{ id: 'a', text: 'Inspect', status: 'completed' }]).revision, 2);
    const message = { id: 'message', fromSessionId: 'root', toSessionId: 'root', sourceRunId: 'run', kind: 'message' as const, text: 'retained message', wake: false };
    assert.equal(coordination.enqueue(message, 'key'), message.id);
    assert.equal(coordination.enqueue({ ...message, id: 'duplicate' }, 'key'), message.id);
    database.close();
    database = await openWorkspaceDatabase(dbPath);
    const reopened = new SqliteAgentCoordinationRepository(database);
    assert.equal(reopened.plan('root').revision, 2);
    assert.equal(reopened.pending('root')[0]?.text, 'retained message');
    database.exec(`
      ALTER TABLE agent_messages DROP COLUMN author;
      ALTER TABLE agent_messages DROP COLUMN model;
      ALTER TABLE agent_messages DROP COLUMN relationship;
      ALTER TABLE agent_messages DROP COLUMN purpose;
      ALTER TABLE agent_messages DROP COLUMN reply_to;
      UPDATE schema_metadata SET version = 21;
      INSERT INTO sessions(id, owner_id, title, created_at, updated_at, parent_session_id, root_session_id)
        VALUES ('child', 'developer:local', 'child', 'now', 'now', 'root', 'root');
      INSERT INTO agent_messages(id, from_session_id, to_session_id, source_run_id, kind, text, wake, consumed, dedupe_key)
        VALUES ('old-mail', 'child', 'root', 'child-run', 'result', 'legacy private body', 1, 1, 'result:child-run'),
               ('old-instruction', 'root', 'child', 'root-run', 'message', 'legacy instruction', 1, 0, 'instruction');
      INSERT INTO agent_runs VALUES ('root-run', 'root');
      INSERT INTO timeline_items VALUES
        ('root-run', 0, 'old-mail', 'message', '{"type":"message","id":"old-mail","role":"user","content":[]}'),
        ('root-run', 1, 'read', 'tool_call', '{"type":"tool_call","name":"read_mail","callId":"old-read"}'),
        ('root-run', 2, 'result', 'tool_result', '{"type":"tool_result","callId":"old-read"}'),
        ('root-run', 3, 'kept', 'message', '{"type":"message","id":"kept","role":"assistant","content":[]}');
    `);
    database.close();
    database = await openWorkspaceDatabase(dbPath);
    const migrated = new SqliteAgentCoordinationRepository(database);
    assert.equal(migrated.pending('child')[0]?.id, 'old-instruction');
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_mail'").get(), undefined);
    assert.equal(database.prepare("SELECT 1 FROM agent_messages WHERE id = 'old-mail'").get(), undefined);
    assert.deepEqual(database.prepare('SELECT item_id, item_order FROM timeline_items').all().map((row) => [row.item_id, row.item_order]), [['kept', 0]]);
  } finally { if (database.isOpen) database.close(); await rm(directory, { recursive: true, force: true }); }
});

test('parallel fresh-context children deliver results; attempted edits are blocked at execution', async () => {
  let simultaneous = 0; let peak = 0;
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) {
      assert.ok(!JSON.stringify(request.transcript).includes('ROOT_ONLY_CONTEXT'));
      assert.ok(!request.tools.some((tool) => ['shell', 'write_file', 'spawn_agent', 'call_mcp_tool'].includes(tool.name)));
      if (!calls(request, 'write_file').length) {
        simultaneous++; peak = Math.max(peak, simultaneous);
        await delay(70, undefined, { signal }); simultaneous--;
        return [call('write_file', { path: 'forbidden.txt', content: 'must not write' })];
      }
      assert.ok(request.transcript.some((item) => item.type === 'tool_result' && item.isError));
      return [text('Child findings')];
    }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'One', prompt: 'Read one' }), call('spawn_agent', { title: 'Two', prompt: 'Read two' })];
    const children = f.workspace.descendants(f.root.id).filter((member) => member.parentSessionId);
    const active = children.filter((member) => member.runs[0]?.status === 'in_progress');
    if (active.length) return [call('wait_agents', { targets: active.map(runTarget), until: 'all', timeoutMs: 1000 })];
    return [text('All findings received')];
  });
  try {
    const sequence = new Map<string, number[]>();
    const off = f.coordinator.subscribe((event) => {
      if (event.type === 'response') for (const item of event.events) {
        const values = sequence.get(item.response_id) ?? [];
        values.push(item.sequence_number); sequence.set(item.response_id, values);
      }
    });
    const requestSequence: number[] = [];
    const result = await f.coordinator.start(f.root, input('ROOT_ONLY_CONTEXT'), options, (event) => {
      requestSequence.push(event.sequence_number);
    });
    assert.deepEqual(requestSequence, sequence.get(result.id));
    assert.equal(result.status, 'completed'); assert.equal(peak, 2);
    const children = f.workspace.descendants(f.root.id).filter((member) => member.parentSessionId);
    assert.equal(children.length, 2);
    assert.ok(children.every((member) => member.cwd === f.root.cwd && member.runs[0]?.permissionSnapshot.permissionMode === 'plan'));
    await assert.rejects(access(path.join(f.projectPath, 'forbidden.txt')));
    assert.equal(f.coordination.pending(f.root.id).length, 0);
    for (const values of sequence.values()) assert.deepEqual(values, values.map((_, index) => index));
    off();
  } finally { await f.close(); }
});

test('child messages and completion preserve parent approval and deliver when it resumes', async () => {
  const review = Promise.withResolvers<void>();
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) {
      await review.promise;
      signal?.throwIfAborted();
      return calls(request, 'send_message').length ? [text('Review ready')] :
        [call('send_message', { sessionId: f.root.id, message: 'Review progress', purpose: 'progress' })];
    }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    if (!calls(request, 'write_file').length) return [call('write_file', { path: 'approved.txt', content: 'approved' })];
    assert.ok(request.transcript.some((item) => item.type === 'message' && item.source?.kind === 'agent' && item.source.purpose === 'progress'));
    return [text('Final')];
  });
  try {
    f.coordinator.updatePlan(f.root, 0, [{ id: 'review', text: 'Review and verify', status: 'in_progress' }]);
    const run = await f.coordinator.start(f.root, input('Start'), options);
    assert.equal(run.status, 'waiting_permission');
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    const receipt = f.coordinator.wait(f.root, { targets: [runTarget(child)], until: 'any', timeoutMs: 2000 });
    review.resolve();
    assert.equal((await receipt).statuses[0]?.output, 'Review ready');
    assert.equal(f.root.runs.length, 1); assert.equal(run.status, 'waiting_permission');
    assert.equal(f.coordination.pending(f.root.id)[0]?.text, 'Review progress');
    const batch = run.pendingToolBatch!;
    const completed = await f.coordinator.resume(f.root, run, batch.id, batch.permissions.map((permission) => ({ permissionId: permission.id, decision: 'approve' })));
    assert.equal(completed.status, 'completed');
    assert.equal(f.coordination.pending(f.root.id).length, 0);
    const compiled = await f.compiler.compile(f.root, []);
    assert.match(compiled.instructions, /Review and verify/);
    assert.equal(f.coordination.plan(f.root.id).items[0]?.status, 'in_progress');
  } finally { review.resolve(); await f.close(); }
});

test('tree shares project admission; unrelated roots conflict; cancellation aborts waits and prevents auto-wake', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) { started(); await delay(10000, undefined, { signal }); return [text('Should not finish')]; }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Slow', prompt: 'Slow review' })];
    const child = f.workspace.descendants(f.root.id).find((item) => item.parentSessionId)!;
    return [call('wait_agents', { targets: [runTarget(child)], timeoutMs: 60000 })];
  });
  try {
    const execution = f.coordinator.start(f.root, input('Start'), options);
    await ready;
    const other = await f.workspace.createSession(owner, { projectId: f.project.id });
    await assert.rejects(f.coordinator.start(other, input('Other root'), options), /active response/);
    await assert.rejects(f.coordinator.start(f.root, input('Duplicate run'), options), /active response/);
    const rootRun = f.root.runs[0]!;
    const child = f.workspace.descendants(f.root.id).find((item) => item.parentSessionId)!;
    const duplicate = await f.coordinator.spawn(f.root, rootRun, child.originCallId!, 'Duplicate', 'Duplicate');
    assert.deepEqual(duplicate, { ...runTarget(child), status: 'in_progress' });
    await f.coordinator.stopTree(f.root);
    assert.equal((await execution).status, 'cancelled');
    await delay(60);
    assert.equal(f.root.runs.length, 1); assert.equal(child.runs[0]?.status, 'cancelled');
  } finally { await f.close(); }
});

test('inbox delivery survives transcript/ack interruption and tree deletion removes coordination state', async () => {
  const f = await fixture(async () => [text('ok')]);
  try {
    const child = await f.workspace.createSession(owner, { projectId: f.project.id, parentSessionId: f.root.id });
    const run = await f.workspace.createResponse(f.root, await input('start')(), snapshot, { permissionMode: 'ask' });
    const message = { id: 'delivery', fromSessionId: child.id, toSessionId: f.root.id, sourceRunId: 'source', kind: 'message' as const, text: 'once', wake: false };
    f.coordination.enqueue(message, 'delivery');
    run.timeline.push({ id: 'delivery', type: 'message', role: 'user', content: [{ type: 'text', text: 'once' }] });
    await f.workspace.touch(f.root, run);
    run.status = 'completed'; await f.workspace.touch(f.root, run);
    await f.coordinator.start(f.root, input('continue'), options);
    assert.equal(f.root.runs.flatMap((item) => item.timeline).filter((item) => item.id === 'delivery').length, 1);
    assert.equal(f.coordination.pending(f.root.id).length, 0);
    await f.coordinator.deleteSession(f.root);
    assert.equal(await f.workspace.getSession(child.id), undefined);
    assert.deepEqual(f.coordination.pending(child.id), []);
  } finally { await f.close(); }
});

test('ordinary completion does not reload a session when no message needs a wake', async () => {
  const f = await fixture(async () => [text('done')]);
  const original = f.workspace.getSession.bind(f.workspace);
  try {
    await f.coordinator.start(f.root, input('ordinary task'), options);
    let postCompletionLoads = 0;
    f.workspace.getSession = async (...args) => { postCompletionLoads++; return original(...args); };
    await delay(30);
    assert.equal(postCompletionLoads, 0);
  } finally { f.workspace.getSession = original; await f.close(); }
});

test('stopping a session aborts input preparation and releases its reservation', { timeout: 5000 }, async () => {
  const f = await fixture(async () => [text('done')]);
  let preparing!: () => void;
  const entered = new Promise<void>((resolve) => { preparing = resolve; });
  let inputPrepared = false;
  try {
    const starting = f.coordinator.start(f.root, async (signal) => {
      preparing();
      await delay(3000, undefined, { signal });
      inputPrepared = true;
      return input('interrupted')();
    }, options);
    const cancelled = assert.rejects(starting, { name: 'AbortError' });
    await entered;
    await f.coordinator.stopTree(f.root);
    await cancelled;
    assert.equal(inputPrepared, false);
    assert.equal(f.root.runs.length, 0);
    assert.equal((await f.coordinator.start(f.root, input('retry'), options)).status, 'completed');
  } finally { await f.close(); }
});

test('a running child keeps its project reserved and its result can be collected without waking the parent', { timeout: 5000 }, async () => {
  const finishChild = new AbortController();
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) {
      const finish = AbortSignal.any([signal!, finishChild.signal]);
      try { await delay(3000, undefined, { signal: finish }); }
      catch (error) { if (!finishChild.signal.aborted) throw error; }
      return [text('child findings')];
    }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    return [text('parent done')];
  });
  try {
    const initial = await f.coordinator.start(f.root, input('delegate'), options);
    assert.equal(initial.status, 'completed');
    const other = await f.workspace.createSession(owner, { projectId: f.project.id });
    await assert.rejects(f.coordinator.start(other, input('conflict'), options), { code: 'project_active_response_exists' });
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    const waiting = f.coordinator.wait(f.root, { targets: [runTarget(child)], until: 'any', timeoutMs: 2000 });
    finishChild.abort();
    const result = await waiting;
    assert.deepEqual(result, {
      statuses: [{ sessionId: child.id, runId: child.runs[0]?.id, status: 'completed', output: 'child findings' }],
      pendingSessionIds: [], needsInput: [], timedOut: false,
    });
    await delay(30);
    assert.equal(f.root.runs.length, 1);
    assert.ok(!JSON.stringify(f.root.runs[0]?.timeline).includes('child findings'));
  } finally { await f.close(); }
});

test('wait_agents delivers the selected run result to the model, desktop streams and history', async () => {
  const output = 'Review findings 40c3';
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      assert.ok(request.tools.some((tool) => tool.name === 'send_message'));
      assert.ok(request.tools.some((tool) => tool.name === 'wait_for_message'));
      assert.ok(!request.tools.some((tool) => tool.name === 'wait_agents'));
      return [text(output)];
    }
    assert.ok(!request.tools.some((tool) => tool.name.endsWith('_mail')));
    assert.ok(request.tools.some((tool) => tool.name === 'wait_for_message'));
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    const { status, ...target } = toolOutput<{ sessionId: string; runId: string; status: string }>(request, 'spawn_agent');
    assert.ok(status);
    const childSession = await f.workspace.getSession(target.sessionId);
    assert.deepEqual(target, runTarget(childSession!));
    if (!calls(request, 'wait_agents').length) return [call('wait_agents', { targets: [target], timeoutMs: 2000 })];
    assert.deepEqual(toolOutput(request, 'wait_agents'), {
      statuses: [{ ...target, status: 'completed', output }],
      pendingSessionIds: [], needsInput: [], timedOut: false,
    });
    if (!calls(request, 'list_agents').length) return [call('list_agents', {})];
    assert.deepEqual(toolOutput(request, 'list_agents'), {
      agents: [{ ...target, title: 'Review', status: 'completed' }],
      plan: { revision: 0, items: [] },
    });
    return [text('Reviewed the results')];
  });
  try {
    const streamed: AgentStreamEvent[] = [];
    const treeEvents: AgentStreamEvent[] = [];
    const off = f.coordinator.subscribe((event) => {
      if (event.type === 'response' && event.sessionId === f.root.id) treeEvents.push(...event.events);
    });
    const run = await f.coordinator.start(f.root, input('Review'), options, (event) => { streamed.push(event); });
    off();
    assert.equal(run.status, 'completed');
    for (const events of [streamed, treeEvents]) {
      const results = events.filter((event) => event.type === 'agent.tool.completed');
      const wait = results.find((event) => event.result.toolName === 'wait_agents');
      assert.ok(wait?.result.ok);
      assert.match(JSON.stringify(wait.result.output), /Review findings 40c3/);
      assert.ok(!JSON.stringify(results.filter((event) => event !== wait)).includes(output));
    }
    const response = toAgentResponseDto(run);
    const waitCall = response.output.find((item) => item.type === 'function_call' && item.name === 'wait_agents');
    assert.ok(waitCall?.type === 'function_call');
    const waitOutput = response.output.find((item) => item.type === 'function_call_output' && item.call_id === waitCall.call_id);
    assert.ok(waitOutput?.type === 'function_call_output');
    assert.equal(JSON.parse(waitOutput.output).output.statuses[0].output, output);
    assert.match(JSON.stringify(await f.coordinator.snapshot(f.root)), /Review findings 40c3/);
    const other = await f.workspace.createSession(owner);
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    await assert.rejects(f.coordinator.wait(other, { targets: [runTarget(child)], until: 'any', timeoutMs: 0 }), /direct child/);
  } finally { await f.close(); }
});

test('wait_agents times out and cancels without consuming child work', async () => {
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) await delay(60000, undefined, { signal });
    return calls(request, 'spawn_agent').length ? [text('Delegated')] : [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
  });
  try {
    await f.coordinator.start(f.root, input('Delegate'), options);
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    const wait = { targets: [runTarget(child)], until: 'any', timeoutMs: 15 } as const;
    assert.deepEqual(await f.coordinator.wait(f.root, wait), {
      statuses: [{ ...runTarget(child), status: 'in_progress' }], pendingSessionIds: [child.id], needsInput: [], timedOut: true,
    });
    const abort = new AbortController();
    const waiting = f.coordinator.wait(f.root, { ...wait, timeoutMs: 60000 }, abort.signal);
    abort.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(child.runs[0]?.status, 'in_progress');
    await f.coordinator.interrupt(f.root, child.id);
    assert.deepEqual((await f.coordinator.wait(f.root, wait)).statuses,
      [{ ...runTarget(child), status: 'cancelled' }]);
  } finally { await f.close(); }
});

test('wait tools return an error when batched and allow the other calls to finish', { timeout: 5000 }, async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) return [text('Child finished')];
    const spawned = calls(request, 'spawn_agent');
    if (!spawned.length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    const { sessionId, runId } = toolOutput<{ sessionId: string; runId: string }>(request, 'spawn_agent');
    const waits = calls(request, 'wait_agents');
    if (!waits.length) return [
      call('wait_for_message', { sessionId, timeoutMs: 60000 }),
      call('wait_agents', { targets: [{ sessionId, runId }], timeoutMs: 60000 }),
      call('send_message', { sessionId, message: 'Proceed with the review' }),
    ];
    if (waits.length === 1) {
      for (const name of ['wait_agents', 'wait_for_message']) {
        const { result, envelope } = toolResult(request, calls(request, name)[0]?.callId);
        assert.equal(result.isError, true);
        assert.match(envelope.error ?? '', /on its own/);
      }
      const sent = toolOutput<{ messageId: string }>(request, 'send_message');
      assert.ok(sent.messageId);
      return [call('wait_agents', { targets: [{ sessionId, messageId: sent.messageId }], timeoutMs: 2000 })];
    }
    assert.equal(toolOutput<{ timedOut: boolean }>(request, 'wait_agents').timedOut, false);
    return [text('Done')];
  });
  try {
    const run = await f.coordinator.start(f.root, input('Review'), options);
    assert.equal(run.status, 'completed', run.error?.message);
  } finally { await f.close(); }
});

for (const replyBeforeWait of [false, true]) {
  test(`clarification interrupts the parent's wait and resumes the same child run (${replyBeforeWait ? 'reply queued first' : 'child waits first'})`, { timeout: 8000 }, async () => {
    const parentWaiting = Promise.withResolvers<void>();
    const childWaiting = Promise.withResolvers<void>();
    const parentAnswered = Promise.withResolvers<void>();
    const independentFinished = new AbortController();
    const question = 'Which output should I inspect?';
    const answer = 'Use the build log.';
    let questionId: string | undefined;
    const f = await fixture(async (request, signal) => {
      const incoming = request.transcript.filter((item) => item.type === 'message' && item.source?.kind === 'agent');
      if (isChild(request)) {
        assert.match(request.instructions, new RegExp(f.root.id));
        const task = incoming.find((item) => item.source?.kind === 'agent' && item.source.purpose === 'task');
        assert.ok(task);
        if (task.content.some((part) => part.type === 'text' && part.text.includes('Independent check'))) {
          try { await delay(60000, undefined, { signal: AbortSignal.any([signal!, independentFinished.signal]) }); }
          catch (error) { if (!independentFinished.signal.aborted) throw error; }
          return [text('Independent findings')];
        }
        if (!calls(request, 'send_message').length) {
          await parentWaiting.promise;
          return [call('send_message', { sessionId: f.root.id, message: question, purpose: 'clarification', replyTo: task.id })];
        }
        questionId = toolOutput<{ messageId: string }>(request, 'send_message').messageId;
        if (!calls(request, 'wait_for_message').length) {
          if (replyBeforeWait) await parentAnswered.promise;
          return [call('wait_for_message', { sessionId: f.root.id, replyTo: questionId, timeoutMs: 4000 })];
        }
        const receipt = toolOutput<{ messageId: string; timedOut: boolean }>(request, 'wait_for_message');
        assert.equal(receipt.timedOut, false);
        const received = incoming.filter((item) => item.id === receipt.messageId);
        assert.equal(received.length, 1);
        assert.equal(received[0]?.source?.kind, 'agent');
        assert.equal(received[0].source.replyTo, questionId);
        assert.match(JSON.stringify(received[0].content), /Use the build log/);
        independentFinished.abort();
        return [text('Build log findings')];
      }

      if (!calls(request, 'spawn_agent').length) return [
        call('spawn_agent', { title: 'Review', prompt: 'Inspect the output' }),
        call('spawn_agent', { title: 'Independent', prompt: 'Independent check' }),
      ];
      const children = f.workspace.descendants(f.root.id).filter((session) => session.parentSessionId);
      const review = children.find((session) => session.title === 'Review')!;
      const wait = { targets: children.map(runTarget), until: 'all', timeoutMs: 4000 };
      const waits = calls(request, 'wait_agents');
      if (!waits.length) return [call('wait_agents', wait)];
      if (!calls(request, 'send_message').length) {
        const clarification = incoming.find((item) => item.source?.kind === 'agent' && item.source.purpose === 'clarification');
        assert.ok(clarification?.source?.kind === 'agent');
        const interrupted = toolOutput<{ needsInput: unknown[]; pendingSessionIds: string[]; timedOut: boolean }>(request, 'wait_agents');
        assert.equal(interrupted.timedOut, false);
        assert.deepEqual(interrupted.needsInput, [{ ...runTarget(review), messageId: clarification.id }]);
        assert.ok(interrupted.pendingSessionIds.includes(children.find((session) => session.title === 'Independent')!.id));
        assert.equal(clarification.source.replyTo, review.runs[0]?.input[0]?.id);
        assert.match(JSON.stringify(clarification.content), /Actl agent message/);
        if (!replyBeforeWait) {
          await childWaiting.promise;
          const sent = await f.coordinator.send(f.root, f.root.runs[0]!, review.id, 'Review the first failure.', 'queued-before-answer');
          const target = { sessionId: review.id, messageId: sent.messageId };
          const queued = await f.coordinator.wait(f.root, { targets: [target], until: 'all', timeoutMs: 0 });
          assert.deepEqual(queued, {
            statuses: [{ ...target, status: 'queued' }], pendingSessionIds: [review.id],
            needsInput: interrupted.needsInput, timedOut: false,
          });
        }
        return [call('send_message', { sessionId: review.id, message: answer, replyTo: clarification.id })];
      }
      parentAnswered.resolve();
      if (waits.length === 1) return [call('wait_agents', wait)];
      const completed = toolOutput<{ statuses: Array<{ output?: string }>; pendingSessionIds: string[] }>(request, 'wait_agents');
      assert.deepEqual(completed.pendingSessionIds, []);
      assert.deepEqual(completed.statuses.map(({ output }) => output).sort(), ['Build log findings', 'Independent findings']);
      return [text('Parent finished')];
    });

    const wait = f.coordinator.wait.bind(f.coordinator);
    f.coordinator.wait = (...args) => {
      const waiting = wait(...args);
      parentWaiting.resolve();
      return waiting;
    };
    const waitForMessage = f.coordinator.waitForMessage.bind(f.coordinator);
    f.coordinator.waitForMessage = (...args) => {
      const waiting = waitForMessage(...args);
      childWaiting.resolve();
      return waiting;
    };

    try {
      const events: AgentStreamEvent[] = [];
      const run = await f.coordinator.start(f.root, input('Review'), options, (event) => { events.push(event); });
      assert.equal(run.status, 'completed', run.error?.message);
      const child = f.workspace.descendants(f.root.id).find((session) => session.title === 'Review')!;
      assert.equal(child.runs.length, 1);
      assert.equal(child.runs[0]?.status, 'completed', child.runs[0]?.error?.message);
      const received = toAgentResponseDto(run).output.filter((item) => item.type === 'message' && item.id === questionId);
      assert.equal(received.length, 1);
      assert.ok(received[0]?.type === 'message');
      assert.deepEqual(received[0].content, [{ type: 'output_text', text: question, annotations: [] }]);
      assert.deepEqual(received[0].source, { kind: 'agent', sessionId: child.id, runId: child.runs[0]?.id, model: 'Fake',
        relationship: 'child', purpose: 'clarification', replyTo: child.runs[0]?.input[0]?.id });
      assert.ok(events.some((event) => event.type === 'response.output_item.done' && event.item.id === questionId));
      assert.deepEqual(f.coordination.pending(f.root.id), []);
      assert.deepEqual(f.coordination.pending(child.id), []);
      await assert.rejects(f.coordinator.waitForMessage(child, { sessionId: f.root.id, replyTo: child.runs[0]?.input[0]?.id, timeoutMs: 0 }), /replyTo/);
      await assert.rejects(f.coordinator.send(f.root, run, child.id, answer, 'bad-reply', { replyTo: child.runs[0]?.input[0]?.id }), /replyTo/);
      await assert.rejects(f.coordinator.send(child, child.runs[0]!, child.id, question, 'self'), /direct child/);
      await assert.rejects(f.coordinator.send(child, child.runs[0]!, f.root.id, question, 'human-up', { userFollowUp: true }), /direct child/);
    } finally {
      parentWaiting.resolve();
      childWaiting.resolve();
      parentAnswered.resolve();
      independentFinished.abort();
      await f.close();
    }
  });
}

test('wait_agents can return for any child or wait for all children', async () => {
  const finishFirst = new AbortController();
  const finishSecond = new AbortController();
  const f = await fixture(async (request, signal) => {
    if (!isChild(request)) {
      return calls(request, 'spawn_agent').length ? [text('Delegated')] : [
        call('spawn_agent', { title: 'First', prompt: 'First assignment' }),
        call('spawn_agent', { title: 'Second', prompt: 'Second assignment' }),
      ];
    }
    const first = JSON.stringify(request.transcript).includes('First assignment');
    const finish = first ? finishFirst.signal : finishSecond.signal;
    try { await delay(60000, undefined, { signal: AbortSignal.any([signal!, finish]) }); }
    catch (error) { if (!finish.aborted) throw error; }
    return [text('Finished')];
  });
  try {
    await f.coordinator.start(f.root, input('Delegate'), options);
    const children = f.workspace.descendants(f.root.id);
    const first = children.find((child) => child.title === 'First')!;
    const second = children.find((child) => child.title === 'Second')!;
    const wait = { targets: [runTarget(first), runTarget(second)], timeoutMs: 2000 };
    await f.coordinator.send(first, first.runs[0]!, f.root.id, 'Still working', 'progress', { purpose: 'progress' });
    const before = await f.coordinator.wait(f.root, { ...wait, until: 'any', timeoutMs: 0 });
    assert.deepEqual(before.pendingSessionIds, [first.id, second.id]);
    assert.equal(before.timedOut, true);

    const anyStatus = f.coordinator.wait(f.root, { ...wait, until: 'any' });
    const allStatus = f.coordinator.wait(f.root, { ...wait, until: 'all' });
    finishFirst.abort();
    const any = await anyStatus;
    assert.equal(any.timedOut, false);
    assert.deepEqual(any.pendingSessionIds, [second.id]);
    const partial = await f.coordinator.wait(f.root, { ...wait, until: 'all', timeoutMs: 0 });
    assert.deepEqual(partial.statuses.map((item) => [item.sessionId, item.status, item.output]),
      [[first.id, 'completed', 'Finished'], [second.id, 'in_progress', undefined]]);
    assert.equal(partial.timedOut, true);

    finishSecond.abort();
    const all = await allStatus;
    assert.equal(all.timedOut, false);
    assert.deepEqual(all.pendingSessionIds, []);
  } finally {
    finishFirst.abort();
    finishSecond.abort();
    await f.close();
  }
});

test('message waits resolve to the run that delivered the instruction while exact run waits keep the original result', { timeout: 8000 }, async () => {
  let releaseChild!: () => void;
  const gate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const followUpStarted = Promise.withResolvers<void>();
  const releaseFollowUp = Promise.withResolvers<void>();
  const f = await fixture(async (request) => {
    if (!isChild(request)) {
      return calls(request, 'spawn_agent').length
        ? [text('Parent ready')]
        : [call('spawn_agent', { title: 'Review', prompt: 'Initial assignment' })];
    }
    const actualInput = request.transcript.some((item) => item.type === 'message' && item.content.some((part) => part.type === 'text' && part.text === 'Actual new input'));
    if (actualInput) {
      followUpStarted.resolve();
      await releaseFollowUp.promise;
      return [text('New child result')];
    }
    await gate;
    return [text('Original child result')];
  });
  try {
    const rootRun = await f.coordinator.start(f.root, input('Start'), options);
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    const first = await f.coordinator.send(f.root, rootRun, child.id, 'First instruction', 'first');
    assert.deepEqual(await f.coordinator.send(f.root, rootRun, child.id, 'Duplicate instruction', 'first'), first);
    await f.coordinator.send(f.root, rootRun, child.id, 'Second instruction', 'second');
    const controls = { until: 'any', timeoutMs: 2000 } as const;
    const firstReceipt = f.coordinator.wait(f.root, { ...controls, targets: [{ sessionId: child.id, messageId: first.messageId }] });
    releaseChild();
    const result = await firstReceipt;
    assert.deepEqual(result.statuses, [{ ...runTarget(child), messageId: first.messageId, status: 'completed', output: 'Original child result' }]);
    const firstRun = toAgentResponseDto(child.runs[0]!);
    assert.deepEqual(firstRun.input[0]?.source, {
      kind: 'agent', sessionId: f.root.id, runId: rootRun.id, model: 'Fake', relationship: 'parent', purpose: 'task',
    });
    assert.deepEqual(firstRun.output.flatMap((item) =>
      item.type === 'message' && item.role === 'user' ? item.content : [],
    ).map((part) => part.type === 'output_text' ? part.text : ''), ['First instruction', 'Second instruction']);
    assert.ok(firstRun.output.some((item) => item.type === 'message' && item.role === 'assistant' && item.source?.kind === 'model'));

    const { messageId } = await f.coordinator.send(f.root, rootRun, child.id, 'Actual new input', 'third', { userFollowUp: true });
    const nextTarget = { sessionId: child.id, messageId };
    const queued = await f.coordinator.wait(f.root, { ...controls, targets: [nextTarget], timeoutMs: 0 });
    assert.deepEqual(queued, { statuses: [{ ...nextTarget, status: 'queued' }], pendingSessionIds: [child.id], needsInput: [], timedOut: true });

    await followUpStarted.promise;
    const earlierResult = await f.coordinator.wait(f.root, { ...controls, targets: [runTarget(child)], timeoutMs: 0 });
    assert.equal(earlierResult.timedOut, false);
    assert.deepEqual(earlierResult.statuses, [{ ...runTarget(child), status: 'completed', output: 'Original child result' }]);
    const retry = await f.coordinator.spawn(f.root, rootRun, child.originCallId!, 'Retry', 'Retry');
    assert.deepEqual(retry, { ...runTarget(child), status: 'completed' });
    await assert.rejects(f.coordinator.wait(f.root, { ...controls, targets: [{ sessionId: child.id, runId: rootRun.id }] }), /run/i);
    await assert.rejects(f.coordinator.wait(f.root, { ...controls, targets: [{ sessionId: child.id, messageId: 'unknown-message' }] }), /message/i);

    const next = f.coordinator.wait(f.root, { ...controls, targets: [nextTarget] });
    releaseFollowUp.resolve();
    const nextResult = await next;
    assert.equal(nextResult.timedOut, false);
    assert.equal(child.runs.length, 2);
    assert.deepEqual(nextResult.statuses, [{ ...nextTarget, runId: child.runs[1]?.id, status: 'completed', output: 'New child result' }]);
    const nextRun = toAgentResponseDto(child.runs[1]!);
    assert.deepEqual(nextRun.input[0]?.content, [{ type: 'input_text', text: 'Actual new input' }]);
    assert.equal(nextRun.input[0]?.source?.kind, 'user');
    assert.ok(!nextRun.output.some((item) => item.type === 'message' && item.role === 'user'));
    assert.equal(f.coordination.pending(child.id).length, 0);
  } finally {
    releaseChild();
    releaseFollowUp.resolve();
    await f.close();
  }
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
