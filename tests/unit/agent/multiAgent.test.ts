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
import { AgentLoop } from '../../../src/agent-core/runtime/agent-loop/agent-loop';
import { AgentCoordinator } from '../../../src/agent-core/runtime/multi-agents/agent-coordinator';
import { ProcessSupervisor } from '../../../src/agent-core/runtime/process/process-supervisor';
import { ToolRegistry } from '../../../src/agent-core/tools/registry';
import { SubagentToolProvider } from '../../../src/agent-core/tools/builtin/subagent';
import { FilesystemToolProvider } from '../../../src/agent-core/tools/builtin/filesystem/provider';
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
  const processes = new ProcessSupervisor();
  const compiler = new PromptCompiler(new SqlitePromptSettingsRepository(database), coordination);
  const loop = new AgentLoop(models, registry, new RunPermissionEngine(), new InMemoryHookEventBus(), workspace, files, compiler);
  const coordinator = new AgentCoordinator(workspace, coordination, loop, files, processes);
  loop.support = coordinator;
  registry.registerProvider(new SubagentToolProvider(coordinator, workspace));
  const project = await workspace.createProject(owner, { workspacePaths: [projectPath], primaryWorkspacePath: projectPath });
  const root = await workspace.createSession(owner, { projectId: project.id });
  return { directory, projectPath, coordination, workspace, files, loop, coordinator, root, project, compiler,
    close: async () => { await coordinator.close(); await processes.dispose(); database.close(); await rm(directory, { recursive: true, force: true }); } };
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
    const off = f.coordinator.events.subscribe((event) => {
      if (event.type === 'response') for (const item of event.events) {
        const values = sequence.get(item.response_id) ?? [];
        values.push(item.sequence_number); sequence.set(item.response_id, values);
      }
    });
    const result = await f.loop.run(f.root, input('ROOT_ONLY_CONTEXT'), options, (run, event) => {
      // A second viewer must reuse the same projected event sequence.
      f.coordinator.events.project(run, event);
    });
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
    const run = await f.loop.run(f.root, input('Start'), options);
    assert.equal(run.status, 'waiting_permission');
    await delay(150);
    assert.equal(f.root.runs.length, 1); assert.equal(run.status, 'waiting_permission');
    assert.ok(f.coordination.pending(f.root.id).some((message) => message.kind === 'result'));
    const batch = run.pendingToolBatch!;
    const completed = await f.loop.resolvePermissions(f.root, run, batch.id, batch.permissions.map((permission) => ({ permissionId: permission.id, decision: 'approve' })));
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
    const execution = f.loop.run(f.root, input('Start'), options);
    await ready;
    const other = await f.workspace.createSession(owner, { projectId: f.project.id });
    await assert.rejects(f.loop.run(other, input('Other root'), options), /active response/);
    await assert.rejects(f.loop.run(f.root, input('Duplicate run'), options), /active response/);
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
    await f.coordinator.beforeStep(f.root, run);
    assert.equal(run.timeline.filter((item) => item.id === 'delivery').length, 1);
    assert.equal(f.coordination.pending(f.root.id).length, 0);
    run.status = 'completed'; await f.workspace.touch(f.root, run);
    await f.workspace.deleteSession(owner, f.root.id);
    assert.equal(await f.workspace.getSession(child.id), undefined);
    assert.deepEqual(f.coordination.pending(child.id), []);
  } finally { await f.close(); }
});

test('ordinary completion does not reload a session when no message needs a wake', async () => {
  const f = await fixture(async () => [text('done')]);
  const original = f.workspace.getSession.bind(f.workspace);
  try {
    await f.loop.run(f.root, input('ordinary task'), options);
    let postCompletionLoads = 0;
    f.workspace.getSession = async (...args) => { postCompletionLoads++; return original(...args); };
    await delay(30);
    assert.equal(postCompletionLoads, 0);
  } finally { f.workspace.getSession = original; await f.close(); }
});
