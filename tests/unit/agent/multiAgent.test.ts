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

const owner = 'developer:local';
const snapshot: ModelExecutionSnapshot = { targetId: 'fake', displayName: 'Fake', providerModel: 'fake', accountId: 'fake',
  accountVersion: 1, credentialVersion: 1, baseURL: 'http://127.0.0.1:1', protocol: 'chat_completions', capabilities: TEXT_TOOL_CAPABILITIES };
const text = (value: string): TranscriptItem => ({ type: 'message', id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: value }] });
const call = (name: string, input: unknown, id = randomUUID()): TranscriptItem => ({ type: 'tool_call', id, callId: id, name, argumentsJson: JSON.stringify(input) });
const input = (value: string) => async () => [{ type: 'message' as const, id: randomUUID(), role: 'user' as const, content: [{ type: 'text' as const, text: value }] }];
const isChild = (request: ModelTurnRequest) => request.instructions.includes('You are a read-only child');
const calls = (request: ModelTurnRequest, name: string) => request.transcript.filter((item) => item.type === 'tool_call' && item.name === name);
const options = { model: 'fake', permissionMode: 'ask' as const };

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
    CREATE TABLE timeline_items(run_id TEXT, item_id TEXT, item_type TEXT, payload_json TEXT);
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
    assert.equal(coordination.enqueue(message, 'key'), true);
    assert.equal(coordination.enqueue({ ...message, id: 'duplicate' }, 'key'), false);
    database.close();
    database = await openWorkspaceDatabase(dbPath);
    const reopened = new SqliteAgentCoordinationRepository(database);
    assert.equal(reopened.plan('root').revision, 2);
    assert.equal(reopened.pending('root')[0]?.text, 'retained message');
    database.exec(`
      DROP TABLE agent_mail;
      ALTER TABLE agent_messages DROP COLUMN author;
      ALTER TABLE agent_messages DROP COLUMN model;
      UPDATE schema_metadata SET version = 21;
      INSERT INTO sessions(id, owner_id, title, created_at, updated_at, parent_session_id, root_session_id)
        VALUES ('child', 'developer:local', 'child', 'now', 'now', 'root', 'root');
      INSERT INTO agent_messages(id, from_session_id, to_session_id, source_run_id, kind, text, wake, consumed, dedupe_key)
        VALUES ('old-mail', 'child', 'root', 'child-run', 'result', 'legacy private body', 1, 1, 'result:child-run'),
               ('old-instruction', 'root', 'child', 'root-run', 'message', 'legacy instruction', 1, 0, 'instruction');
      INSERT INTO agent_runs VALUES ('root-run', 'root');
      INSERT INTO timeline_items VALUES ('root-run', 'old-mail', 'message',
        '{"type":"message","id":"old-mail","role":"user","content":[{"type":"text","text":"legacy private body"}]}');
    `);
    database.close();
    database = await openWorkspaceDatabase(dbPath);
    const migrated = new SqliteAgentCoordinationRepository(database);
    assert.equal(migrated.listMail('root', { limit: 5 })[0]?.read, true);
    assert.equal(migrated.listMail('root', { limit: 5 })[0]?.sentAt, null);
    assert.equal(migrated.readMail('root', 'old-mail')?.body, 'legacy private body');
    assert.equal(migrated.pending('child')[0]?.id, 'old-instruction');
    assert.equal(database.prepare("SELECT json_extract(payload_json, '$.source.kind') AS source FROM timeline_items").get()?.source, 'mail');
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
    if (children.some((member) => member.runs.at(-1)?.status === 'in_progress')) return [call('wait_agents', { sessionIds: children.filter((member) => member.runs.at(-1)?.status === 'in_progress').map((member) => member.id), timeoutMs: 1000 })];
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

test('child completion does not resume a parent through pending approval; plan remains in compiled context', async () => {
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) { await delay(50, undefined, { signal }); return [text('Review ready')]; }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    if (!calls(request, 'write_file').length) return [call('write_file', { path: 'approved.txt', content: 'approved' })];
    return [text('Final')];
  });
  try {
    f.coordinator.updatePlan(f.root, 0, [{ id: 'review', text: 'Review and verify', status: 'in_progress' }]);
    const run = await f.coordinator.start(f.root, input('Start'), options);
    assert.equal(run.status, 'waiting_permission');
    await delay(150);
    assert.equal(f.root.runs.length, 1); assert.equal(run.status, 'waiting_permission');
    assert.ok(f.coordination.listMail(f.root.id, { limit: 10 }).some((message) => message.kind === 'result'));
    const batch = run.pendingToolBatch!;
    const completed = await f.coordinator.resume(f.root, run, batch.id, batch.permissions.map((permission) => ({ permissionId: permission.id, decision: 'approve' })));
    assert.equal(completed.status, 'completed');
    assert.equal(f.coordination.pending(f.root.id).length, 0);
    const compiled = await f.compiler.compile(f.root, []);
    assert.match(compiled.instructions, /Review and verify/);
    assert.equal(f.coordination.plan(f.root.id).items[0]?.status, 'in_progress');
  } finally { await f.close(); }
});

test('tree shares project admission; unrelated roots conflict; cancellation aborts waits and prevents auto-wake', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async (request, signal) => {
    if (isChild(request)) { started(); await delay(10000, undefined, { signal }); return [text('Should not finish')]; }
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Slow', prompt: 'Slow review' })];
    const child = f.workspace.descendants(f.root.id).find((item) => item.parentSessionId)!;
    return [call('wait_agents', { sessionIds: [child.id], timeoutMs: 60000 })];
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
    assert.equal(duplicate.sessionId, child.id);
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

test('a running child keeps its project reserved and sends a receipt without waking its parent', { timeout: 5000 }, async () => {
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
    const waiting = f.coordinator.waitForMail(f.root, undefined, 2000);
    finishChild.abort();
    const receipt = (await waiting).items[0]!;
    assert.equal(receipt.kind, 'result');
    assert.match(f.coordinator.readMail(f.root, receipt.id).body, /child findings/);
    await delay(30);
    assert.equal(f.root.runs.length, 1);
    assert.ok(!JSON.stringify(f.root.runs[0]?.timeline).includes('child findings'));
  } finally { await f.close(); }
});

test('mail reaches the model as a tool result and projects metadata to both desktop streams', async () => {
  const body = 'private findings 40c3';
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      assert.ok(request.tools.some((tool) => tool.name === 'send_mail'));
      assert.ok(!request.tools.some((tool) => tool.name === 'send_message' || tool.name === 'read_mail'));
      if (!calls(request, 'send_mail').length) return [call('send_mail', { subject: 'Progress report', body })];
      return [text('Child completed')];
    }
    assert.ok(!request.tools.some((tool) => tool.name === 'send_mail'));
    if (!calls(request, 'spawn_agent').length) return [call('spawn_agent', { title: 'Review', prompt: 'Review' })];
    if (!calls(request, 'wait_for_mail').length) return [call('wait_for_mail', { timeoutMs: 2000 })];
    if (!calls(request, 'read_mail').length) {
      assert.ok(!JSON.stringify(request.transcript).includes(body));
      const id = f.coordinator.listMail(f.root, { limit: 10 }).items.find((mail) => mail.subject === 'Progress report')!.id;
      return [call('read_mail', { mailId: id })];
    }
    assert.ok(request.transcript.some((item) => item.type === 'tool_result' && JSON.stringify(item).includes(body)));
    return [text('Reviewed the progress report')];
  });
  try {
    const streamed: unknown[] = [];
    const treeEvents: unknown[] = [];
    const off = f.coordinator.subscribe((event) => {
      if (event.type === 'response' && event.sessionId === f.root.id) treeEvents.push(event);
    });
    const run = await f.coordinator.start(f.root, input('Review'), options, (event) => { streamed.push(event); });
    off();
    assert.equal(run.status, 'completed');
    for (const result of [streamed, treeEvents, toAgentResponseDto(run), await f.coordinator.snapshot(f.root)]) {
      assert.match(JSON.stringify(result), /Progress report/);
      assert.ok(!JSON.stringify(result).includes(body));
    }
    assert.ok((await f.coordinator.waitForMail(f.root, undefined, 2000)).items.some((item) => item.kind === 'result'));
    const { items, nextBeforeId } = f.coordinator.listMail(f.root, { limit: 1 });
    assert.equal(items.length, 1);
    assert.ok(nextBeforeId);
    assert.equal(f.coordinator.listMail(f.root, { beforeId: nextBeforeId, limit: 5 }).items.length, 1);
    const message = f.coordinator.listMail(f.root, { unread: false, limit: 10 }).items[0]!;
    assert.equal(f.coordinator.readMail(f.root, message.id).body, body);
    const other = await f.workspace.createSession(owner);
    assert.throws(() => f.coordinator.readMail(other, message.id), /not found/);
  } finally { await f.close(); }
});

test('mail waits time out and cancel without consuming messages', async () => {
  const f = await fixture(async () => [text('Ready')]);
  try {
    assert.deepEqual(await f.coordinator.waitForMail(f.root, undefined, 15), { items: [], timedOut: true });
    const abort = new AbortController();
    const waiting = f.coordinator.waitForMail(f.root, undefined, 60000, abort.signal);
    abort.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.deepEqual(f.coordinator.listMail(f.root, { limit: 5 }).items, []);
  } finally { await f.close(); }
});

test('running children get ordered user instructions in their timeline and idle children start with the actual input', async () => {
  let releaseChild!: () => void;
  const gate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const f = await fixture(async (request) => {
    if (!isChild(request)) {
      return calls(request, 'spawn_agent').length
        ? [text('Parent ready')]
        : [call('spawn_agent', { title: 'Review', prompt: 'Initial assignment' })];
    }
    await gate;
    return [text('Child ready')];
  });
  try {
    const rootRun = await f.coordinator.start(f.root, input('Start'), options);
    const child = f.workspace.descendants(f.root.id).find((session) => session.parentSessionId)!;
    await f.coordinator.send(f.root, rootRun, child.id, 'First instruction', 'first');
    await f.coordinator.send(f.root, rootRun, child.id, 'Duplicate instruction', 'first');
    await f.coordinator.send(f.root, rootRun, child.id, 'Second instruction', 'second');
    const firstReceipt = f.coordinator.waitForMail(f.root, child.id, 2000);
    releaseChild();
    for (const receipt of (await firstReceipt).items) f.coordinator.readMail(f.root, receipt.id);
    const firstRun = toAgentResponseDto(child.runs[0]!);
    assert.equal(firstRun.input[0]?.source?.kind, 'model');
    assert.deepEqual(firstRun.output.flatMap((item) =>
      item.type === 'message' && item.role === 'user' ? item.content : [],
    ).map((part) => part.type === 'output_text' ? part.text : ''), ['First instruction', 'Second instruction']);
    assert.ok(firstRun.output.some((item) => item.type === 'message' && item.role === 'assistant' && item.source?.kind === 'model'));

    await f.coordinator.send(f.root, rootRun, child.id, 'Actual new input', 'third', true);
    assert.ok((await f.coordinator.waitForMail(f.root, child.id, 2000)).items.length);
    assert.equal(child.runs.length, 2);
    const nextRun = toAgentResponseDto(child.runs[1]!);
    assert.deepEqual(nextRun.input[0]?.content, [{ type: 'input_text', text: 'Actual new input' }]);
    assert.equal(nextRun.input[0]?.source?.kind, 'user');
    assert.ok(!nextRun.output.some((item) => item.type === 'message' && item.role === 'user'));
    assert.equal(f.coordination.pending(child.id).length, 0);
  } finally {
    releaseChild();
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
