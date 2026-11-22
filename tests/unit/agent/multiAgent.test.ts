import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, access, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspaceDatabase } from '../../../src/agent-core/repositories/sqlite/database';
import { migrateAgentNames } from '../../../src/agent-core/repositories/sqlite/migrations/v27-to-v28';
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
import { SkillCatalog } from '../../../src/agent-core/skills';
import { TEXT_TOOL_CAPABILITIES, type ModelExecutionSnapshot } from '../../../src/agent-core/model/catalog-types';
import type { ModelClient } from '../../../src/agent-core/model/client';
import type { ModelTurnRequest, ModelUsage, TranscriptItem } from '../../../src/agent-core/model/types';
import type { AgentRunRecord } from '../../../src/agent-core/runtime/agent-domain';
import type { AgentStreamEvent } from '../../../src/shared/agent/responses';

const owner = 'developer:local';
const snapshot: ModelExecutionSnapshot = { targetId: 'fake', displayName: 'Fake', providerModel: 'fake', accountId: 'fake',
  accountVersion: 1, credentialVersion: 1, baseURL: 'http://127.0.0.1:1', protocol: 'chat_completions', capabilities: TEXT_TOOL_CAPABILITIES };
const text = (value: string): TranscriptItem => ({ type: 'message', id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: value }] });
const call = (name: string, input: unknown, id = randomUUID()): TranscriptItem => ({ type: 'tool_call', id, callId: id, name, argumentsJson: JSON.stringify(input) });
const input = (value: string) => async () => [{ type: 'message' as const, id: randomUUID(), role: 'user' as const, content: [{ type: 'text' as const, text: value }] }];
const isChild = (request: ModelTurnRequest) => request.instructions.includes('Your parent can be addressed as @parent.');
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
const publishBuild = (title: string) => team('tasks', { action: 'publish', ...taskDraft(title, 'Edit the shared file.'), type: 'build' });

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

async function fixture(handler: (request: ModelTurnRequest, signal?: AbortSignal) => Promise<TranscriptItem[]>, usage?: ModelUsage) {
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
    ...(usage ? { usage } : {}),
  }) };
  models.resolveSnapshot = async () => structuredClone(snapshot);
  models.getClientForSnapshot = async () => client;
  const makeCoordinator = () => {
    const registry = new ToolRegistry();
    registry.registerProvider(new FilesystemToolProvider());
    registry.registerProvider(new ShellToolProvider());
    const coordinator = new AgentCoordinator(workspace, coordination, new ProcessSupervisor(), {
      models, files, toolRegistry: registry, permissions: new RunPermissionEngine(),
      hooks: new InMemoryHookEventBus(), promptCompiler: new PromptCompiler(new SqlitePromptSettingsRepository(database)),
      logger: createSilentLogger(), skills: new SkillCatalog({ actlHome: directory }),
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
    profile: { id: 'review', name: 'Review', access: 'read_only', description: 'Review work.', instructions: 'Report findings.' } });
}

test('plan changes preserve instructions and saved Skill references replay unchanged after restart', async () => {
  const requests: ModelTurnRequest[] = [];
  const f = await fixture(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      return [team('plan', { action: 'replace', revision: 1, items: [{ id: 'a', text: 'Updated', status: 'completed' }] })];
    }
    return [text('Done')];
  });
  try {
    const skillDirectory = path.join(f.directory, 'skills', 'sample');
    await mkdir(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, 'SKILL.md');
    await writeFile(skillPath, '---\nname: sample\ndescription: Original description\n---\nUse sample.');
    const { data: [skill] } = await new SkillCatalog({ actlHome: f.directory }).listSkillSummaries();
    assert.ok(skill?.available);
    f.coordination.updatePlan(f.root.id, 0, [{ id: 'a', text: 'Initial', status: 'pending' }]);
    const firstRun = await f.coordinator.start(f.root, async () => [{
      id: 'skill-selection', type: 'message', role: 'user', content: [{ type: 'skill', id: skill.id }],
    }], options);
    assert.equal(firstRun.status, 'completed');
    await writeFile(skillPath, '---\nname: sample\ndescription: New description\n---\nUse sample.');
    await f.restart();
    assert.equal((await f.coordinator.start(f.root, input('Continue'), options)).status, 'completed');

    const [first, second, next] = requests;
    assert.ok(first && second && next);
    assert.doesNotMatch(JSON.stringify(first), /Initial/);
    assert.deepEqual(toolOutput(second, 'plan'), { revision: 2, items: [{ id: 'a', text: 'Updated', status: 'completed' }] });
    assert.equal(second.instructions, first.instructions);
    assert.equal(next.instructions, first.instructions);
    assert.match(requestText(first), /<selected_skill_reference>[\s\S]*Original description/);
    assert.deepEqual(next.transcript[0], first.transcript[0]);
  } finally { await f.close(); }
});

test('cache usage is persisted across permission resume', async () => {
  const usage = { inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 1200 };
  const f = await fixture(async (request) => calls(request, 'write_file').length
    ? [text('Done')]
    : [call('write_file', { path: 'approved.txt', content: 'ok' })], usage);
  try {
    const run = await f.coordinator.start(f.root, input('Start'), options);
    const batch = run.pendingToolBatch;
    assert.ok(batch);
    const decisions = batch.permissions.map(({ id }) => ({ permissionId: id, decision: 'approve' as const }));
    assert.equal((await f.coordinator.resume(f.root, run, batch.id, decisions)).status, 'completed');
    const records = await new SqliteSessionRepository(f.database, new SqliteStoredFileRepository(f.database)).loadSessionContent(f.root.id);
    assert.deepEqual(records.invocationUsage.map(({ step, ...record }) => ({
      step, inputTokens: record.inputTokens, cachedInputTokens: record.cachedInputTokens, cacheWriteInputTokens: record.cacheWriteInputTokens,
    })), [{ step: 0, ...usage }, { step: 1, ...usage }]);
  } finally { await f.close(); }
});

test('the parent tree keeps search results with their delegating run across restart and child reuse', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    await f.coordinator.close();
    const complete = async (session: typeof f.root, run: AgentRunRecord, output: string) => {
      run.status = 'completed';
      run.finalOutput = output;
      run.completedAt = new Date().toISOString();
      run.timeline.push(text(output));
      await f.workspace.touch(session, run);
      f.coordination.finishRun(run.id);
    };
    const child = await childOf(f, 'Search worker');
    const firstParent = await f.workspace.createResponse(f.root, await input('Find sources')(), snapshot, { permissionMode: 'ask' });
    await complete(f.root, firstParent, 'Search delegated');
    const task = f.coordination.createTask(f.root.id, f.root.id, taskDraft('Search'), 'search-task');
    const assigned = f.coordination.assignTask(f.root.id, task.id, child.id, { kind: 'delegate', sourceRunId: firstParent.id }, 'search-delegation');
    const searchRun = await f.workspace.createResponse(child, await input('Search the web')(), snapshot, { permissionMode: 'plan' },
      { work: { kind: 'attempt', attemptId: assigned.attempt!.id }, mailIds: [], notificationIds: [] });
    const latestParent = await f.workspace.createResponse(f.root, await input('Another request')(), snapshot, { permissionMode: 'ask' });
    await complete(f.root, latestParent, 'Another reply');
    const callId = randomUUID();
    searchRun.timeline.push(
      { type: 'web_search', id: 'native-search', status: 'completed',
        action: { type: 'search', queries: ['native'], sources: [{ type: 'url', url: 'https://example.com/native' }] } },
      call('read_file', { path: 'unrelated.txt' }),
      call('web_search', { query: 'local tool' }, callId),
      { type: 'tool_result', id: 'search-result', callId, isError: false,
        content: [{ type: 'json', value: { ok: true, output: { results: [{ url: 'https://example.com/local', title: 'Local search' }] } } }] },
    );
    await complete(child, searchRun, 'Search found two sources');
    const latestChild = await f.workspace.createResponse(child, await input('Follow up')(), snapshot, { permissionMode: 'plan' });
    await complete(child, latestChild, 'No new sources');
    const tree = await f.coordinator.snapshot(f.root);
    assert.equal(tree.members.find(({ session }) => session.id === child.id)?.response?.id, latestChild.id);
    assert.equal(tree.childRunResults.length, 1);
    const [result] = tree.childRunResults;
    assert.deepEqual({ ...result!, searchOutput: undefined },
      { parentRunId: firstParent.id, sessionId: child.id, runId: searchRun.id, hasFileChanges: false, searchOutput: undefined });
    assert.deepEqual(result!.searchOutput.map(({ type }) => type), ['web_search_call', 'function_call', 'function_call_output']);
    assert.match(JSON.stringify(result!.searchOutput), /example\.com\/native/);
    assert.match(JSON.stringify(result!.searchOutput), /example\.com\/local/);

    await f.restart();
    assert.deepEqual((await f.coordinator.snapshot(f.root)).childRunResults, tree.childRunResults);
  } finally { await f.close(); }
});

test('concurrent editor approvals validate the shared file version under the project write lock', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      assert.ok(request.tools.some(({ name }) => name === 'write_file'));
      assert.ok(request.tools.some(({ name }) => name === 'shell'));
      assert.ok(!request.tools.some(({ name }) => ['move_path', 'delete_path', 'call_mcp_tool'].includes(name)));
      if (!calls(request, 'read_file').length) return [call('read_file', { path: 'shared.txt' })];
      if (!calls(request, 'write_file').length) {
        const read = toolOutput<{ sha256: string; content: string }>(request, 'read_file');
        assert.equal(read.content, 'original\r\ntext\r\n');
        const content = requestText(request).includes('Begin task #1:') ? 'first' : 'second';
        return [call('write_file', { path: 'shared.txt', content, expectedSha256: read.sha256 })];
      }
      const { result, envelope } = toolResult(request, calls(request, 'write_file').at(-1)?.callId);
      if (result.isError) {
        assert.match(envelope.error ?? '', /SHA-256 precondition failed for shared.txt/);
        return [text('Version conflict')];
      }
      return [text('Updated the shared file')];
    }
    const published = calls(request, 'tasks').length;
    if (published < 2) return [publishBuild(`Edit shared file ${published + 1}`)];
    const delegated = calls(request, 'delegate_task').length;
    if (delegated < 2) return [call('delegate_task', { task: `#${delegated + 1}`,
      target: { kind: 'create', role: 'build', name: `Builder ${delegated + 1}` } })];
    return [text('Delegated both edits')];
  });
  try {
    const file = path.join(f.projectPath, 'shared.txt');
    await writeFile(file, 'original\r\ntext\r\n');
    assert.equal((await f.coordinator.start(f.root, input('Start concurrent edits'), options)).status, 'completed');
    const pending = await until(async () => {
      const tree = await f.coordinator.snapshot(f.root);
      const members = tree.members.filter(({ response, session }) =>
        session.parentSessionId === f.root.id && response?.status === 'waiting_permission');
      return members.length === 2 ? members : undefined;
    }, 'Both builders should request approval after reading the same file.');
    assert.equal(await readFile(file, 'utf8'), 'original\r\ntext\r\n');
    const finished = await Promise.all(pending.map(async ({ session, response }) => {
      const child = (await f.workspace.getSession(session.id, owner))!;
      const run = child.runs.at(-1)!;
      const batch = response!.pending_permission_batch!;
      assert.equal(response!.permission_mode, 'ask');
      return f.coordinator.resume(child, run, batch.id, batch.permissions.map(({ id }) => ({ permissionId: id, decision: 'approve' })));
    }));
    assert.deepEqual(finished.map(({ finalOutput }) => finalOutput).sort(), ['Updated the shared file', 'Version conflict']);
    assert.match(await readFile(file, 'utf8'), /^(first|second)$/);
  } finally { await f.close(); }
});

test('the build role respects the root permission mode and workspace boundary', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      if (request.instructions.includes('read-only workspace access')) {
        assert.ok(request.tools.some(({ name }) => name === 'shell'));
        assert.ok(!request.tools.some(({ name }) => ['write_file', 'apply_patch'].includes(name)));
        return [text('Read-only builder')];
      }
      if (!calls(request, 'write_file').length) return [
        call('write_file', { path: '../outside.txt', content: 'outside' }),
        call('write_file', { path: 'inside.txt', content: 'inside' }),
      ];
      const [outside, inside] = calls(request, 'write_file');
      assert.match(toolResult(request, outside?.callId).envelope.error ?? '', /outside its workspace/);
      assert.ok(!toolResult(request, inside?.callId).result.isError);
      return [text('Edited inside the workspace')];
    }
    if (!calls(request, 'list_agent_profiles').length) return [call('list_agent_profiles', {})];
    const profiles = toolOutput<{ id: string }[]>(request, 'list_agent_profiles');
    assert.deepEqual(profiles.map(({ id }) => id), ['build', 'explore', 'general', 'review']);
    if (!calls(request, 'tasks').length) return [publishBuild('Edit if permitted')];
    if (!calls(request, 'delegate_task').length) return [call('delegate_task', { task: '#1', target: { kind: 'create', role: 'build' } })];
    return [text('Delegated')];
  });
  try {
    for (const mode of ['plan', 'accept_edits'] as const) {
      const root = await f.workspace.createSession(owner, { projectId: f.project.id });
      await f.coordinator.start(root, input('Delegate a build'), { ...options, permissionMode: mode });
      const result = await until(async () => (await f.coordinator.snapshot(root)).tasks?.[0]?.attempt?.result, 'Builder should finish.');
      assert.equal(result.output, mode === 'plan' ? 'Read-only builder' : 'Edited inside the workspace');
      await f.coordinator.stopTree(root);
    }
    await assert.rejects(access(path.join(f.directory, 'outside.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(f.projectPath, 'inside.txt'), 'utf8'), 'inside');
  } finally { await f.close(); }
});

function post(f: Awaited<ReturnType<typeof fixture>>, from: string, to: string, body: string,
  purpose: 'information' | 'question' | 'progress' | 'urgent', replyTo: string | null = null) {
  return f.coordination.sendMail({ rootId: f.root.id, fromSessionId: from, toSessionId: to, subject: body,
    body, purpose, replyTo, author: 'model' }, randomUUID());
}

test('child names are unique per root across creation, renaming and SQLite writes', async () => {
  const f = await fixture(async () => [text('Idle')]);
  try {
    const create = () => childOf(f, 'Checker');
    const [first, duplicate] = await Promise.allSettled([create(), create()]);
    assert.ok(first.status === 'fulfilled');
    assert.ok(duplicate.status === 'rejected');
    assert.equal(duplicate.reason.code, 'agent_name_conflict');
    const child = first.value;
    await assert.rejects(childOf(f, ' ＣＨＥＣＫＥＲ '), { code: 'agent_name_conflict' });
    await assert.rejects(childOf(f, 'parent'), { code: 'agent_name_invalid' });

    const sibling = await childOf(f, 'Reviewer');
    await assert.rejects(f.workspace.updateSession(owner, sibling.id, 'checker'), { code: 'agent_name_conflict' });
    await assert.rejects(f.workspace.updateSession(owner, child.id, undefined), { code: 'agent_name_invalid' });
    assert.throws(() => f.database.prepare('UPDATE sessions SET title = ?, agent_name_key = ? WHERE id = ?')
      .run('Checker', 'checker', sibling.id), /UNIQUE/);

    const otherRoot = await f.workspace.createSession(owner, { projectId: f.project.id });
    const other = await f.workspace.createSession(owner, { projectId: f.project.id, parentSessionId: otherRoot.id, title: 'Checker' });
    assert.equal((await f.coordinator.directory.resolve(otherRoot, '@checker')).id, other.id);

    await f.workspace.updateSession(owner, child.id, ' 审查员 A ');
    assert.equal(child.title, '审查员 A');
    assert.equal((await f.coordinator.directory.resolve(f.root, '@审查员 a')).id, child.id);
    await assert.rejects(f.coordinator.directory.resolve(f.root, '@Checker'), /does not belong/);
    assert.equal((await f.coordinator.directory.resolve(f.root, `@a-${child.id.slice(-10)}`)).id, child.id);

    const firstDefault = await f.workspace.createSession(owner, { projectId: f.project.id, parentSessionId: f.root.id });
    const secondDefault = await f.workspace.createSession(owner, { projectId: f.project.id, parentSessionId: f.root.id });
    assert.equal(firstDefault.title, 'Agent');
    assert.equal(secondDefault.title, 'Agent (2)');
    await f.restart();
    assert.equal((await f.coordinator.directory.resolve(f.root, '@审查员 A')).id, child.id);
  } finally { await f.close(); }
});

test('name migration preserves original unique titles and numbers older duplicates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE sessions(id TEXT PRIMARY KEY, root_session_id TEXT, parent_session_id TEXT, title TEXT, created_at TEXT);
      INSERT INTO sessions VALUES
        ('root', 'root', NULL, 'Root title', '1'),
        ('first', 'root', 'root', 'Reviewer', '2'),
        ('duplicate', 'root', 'root', 'reviewer', '3'),
        ('suffix', 'root', 'root', 'Reviewer (2)', '4'),
        ('other', 'other-root', 'other-root', 'Reviewer', '5'),
        ('missing', 'root', 'root', NULL, '6');
    `);
    migrateAgentNames(db);
    assert.deepEqual(db.prepare('SELECT title FROM sessions ORDER BY created_at').all().map((row) => row.title),
      ['Root title', 'Reviewer', 'reviewer (3)', 'Reviewer (2)', 'Reviewer', 'Agent']);
    assert.throws(() => db.prepare('UPDATE sessions SET agent_name_key = ? WHERE id = ?').run('reviewer', 'duplicate'), /UNIQUE/);
  } finally { db.close(); }
});

test('named references work for mail send, search and wait in the model tools', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      assert.match(request.instructions, /@审查员 A/);
      if (!calls(request, 'mail').length) return [team('mail', { action: 'reply', message: 'm#1', body: 'Answer' })];
      return [text('Replied')];
    }
    const mailCalls = calls(request, 'mail');
    if (!mailCalls.length) return [team('mail', { action: 'send', to: '@审查员 A', subject: 'Question', body: 'Ready?', purpose: 'question' })];
    if (!calls(request, 'wait').length) {
      assert.equal(toolOutput<{ to: string }>(request, 'mail').to, '@审查员 A');
      return [team('wait', { action: 'start', timeoutMs: 4000, condition: { kind: 'mail', from: '@审查员 a', replyTo: 'm#1' } })];
    }
    if (mailCalls.length === 1) {
      assert.equal(toolOutput<{ from: string }>(request, 'wait').from, '@审查员 A');
      return [team('mail', { action: 'search', from: '@审查员 A' })];
    }
    assert.deepEqual(toolOutput<Array<{ body: string }>>(request, 'mail').map(({ body }) => body), ['Answer']);
    return [text('Received')];
  });
  try {
    await childOf(f, '审查员 A');
    const run = await f.coordinator.start(f.root, input('Ask the reviewer'), options);
    assert.equal(run.status, 'completed');
    assert.equal(run.finalOutput, 'Received');
  } finally { await f.close(); }
});

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
      assert.deepEqual(request.tools.map(({ name }) => name).filter((name) => name.startsWith('shell')), ['shell', 'shell_poll', 'shell_stop']);
      assert.ok(!request.tools.some(({ name }) => ['write_file', 'delegate_task', 'call_mcp_tool'].includes(name)));
      assert.doesNotMatch(request.instructions, /Inspect the example|Report evidence|Prioritize actionable findings|Parent checklist/);
      const userText = requestText(request);
      assert.equal(userText.split('Role selected by @parent').length - 1, 1);
      assert.equal(userText.split('Begin task #9: Review').length - 1, 1);
      assert.match(userText, /Assigned by @parent\.[\s\S]*Instructions:\nInspect the example\.[\s\S]*Acceptance criteria:\nReport evidence\./);
      if (!calls(request, 'plan').length) {
        assert.doesNotMatch(JSON.stringify(request), /Parent checklist/);
        return [team('plan', { action: 'read' })];
      }
      assert.deepEqual(toolOutput(request, 'plan'), { revision: 1, items: [{ id: 'check', text: 'Parent checklist', status: 'pending' }] });
      const taskLookups = calls(request, 'tasks');
      if (taskLookups.length === 0) return [team('tasks', { action: 'show', task: '#9' })];
      assert.equal(toolOutput<{ task: string }>(request, 'tasks').task, '#9');
      if (taskLookups.length === 1) return [team('tasks', '{"action":"show","task":9}')];
      if (taskLookups.length === 2) return [team('tasks', { action: 'show' })];
      if (!calls(request, 'write_file').length) return [call('write_file', { path: 'forbidden.txt', content: 'must not write' })];
      assert.ok(toolResult(request, calls(request, 'write_file')[0]?.callId).result.isError);
      if (!calls(request, 'shell').length) return [call('shell', { command: 'Get-Location', hostAccessReason: 'Request host shell' })];
      assert.match(toolResult(request, calls(request, 'shell')[0]?.callId).envelope.error ?? '', /cannot request host shell access/);
      const mailCalls = calls(request, 'mail');
      if (!mailCalls.length) return [team('mail', '{"action":"search","unexpected":true}')];
      assert.match(toolResult(request, mailCalls[0]?.callId).envelope.error ?? '', /Unrecognized key/);
      if (mailCalls.length === 1) return [team('mail', JSON.stringify({ action: 'send', to: '@parent',
        subject: 'Review progress', body: 'Files checked', purpose: 'progress' }))];
      return [text('Reviewed with evidence.')];
    }
    if (calls(request, 'wait').length) {
      assert.deepEqual(toolOutput(request, 'wait'), { status: 'matched', kind: 'task_state', task: '#9', state: 'review_required' });
      assert.equal(requestText(request).split('Files checked').length - 1, 1);
      if (calls(request, 'tasks').length === 1) return [team('tasks', { action: 'accept', task: '9' })];
      assert.equal(toolOutput<{ status: string }>(request, 'tasks').status, 'completed');
      return [text('Accepted')];
    }
    if (!calls(request, 'tasks').length) return [team('tasks', JSON.stringify({ action: 'publish', ...taskDraft('Review') }))];
    if (!calls(request, 'delegate_task').length) return [call('delegate_task', { task: '#9', target: { kind: 'create', role: 'review', name: '审查员' } })];
    assert.equal(toolOutput<{ attempt: { agent: string } }>(request, 'delegate_task').attempt.agent, '@审查员');
    return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#9', states: ['review_required'] } })];
  });
  try {
    for (let i = 1; i < 9; i += 1) f.coordination.createTask(f.root.id, f.root.id, taskDraft(`Unassigned ${i}`), `unassigned-${i}`);
    f.coordination.updatePlan(f.root.id, 0, [{ id: 'check', text: 'Parent checklist', status: 'pending' }]);
    const events: AgentStreamEvent[] = [];
    const run = await f.coordinator.start(f.root, input('Delegate review'), options, (event) => events.push(event));
    assert.equal(run.status, 'completed');
    assert.deepEqual(f.root.runs.map(({ id }) => id), [run.id]);
    assert.equal(events.filter((event) => event.type === 'response.created').length, 1);
    assert.ok(events.some((event) => event.type === 'agent.tool.completed' && event.result.toolName === 'wait'));
    const task = f.coordination.tasks(f.root.id).find(({ number }) => number === 9)!;
    assert.equal(task.status, 'completed');
    assert.equal(task.attempt?.result?.output, 'Reviewed with evidence.');
    await assert.rejects(access(path.join(f.projectPath, 'forbidden.txt')));
    const child = (await f.workspace.getSession(task.attempt!.ownerSessionId))!;
    assert.equal(child.runs.length, 1);
    assert.equal(child.title, '审查员');
    assert.deepEqual(child.runs[0]!.input.map(({ role, source }) => [role, source?.kind]), [['user', 'runtime'], ['user', 'runtime']]);
    assert.deepEqual(f.coordination.pendingMail(f.root.id), []);
  } finally { await f.close(); }
});

for (const delivery of ['active run', 'idle reviewer'] as const) {
  test(`a review notification is delivered once to the ${delivery}`, async () => {
    const childMaySubmit = Promise.withResolvers<void>();
    const reviewText = 'Results are ready for review: #1. Use tasks show.';
    const f = await fixture(async (request) => {
      if (isChild(request)) {
        await childMaySubmit.promise;
        return [text('Reviewed')];
      }
      if (!calls(request, 'tasks').length) return [publish('Review')];
      if (!calls(request, 'delegate_task').length) return [call('delegate_task', { task: '#1', target: { kind: 'create', role: 'review' } })];
      const notices = requestText(request).split(reviewText).length - 1;
      if (!notices) {
        if (delivery === 'active run') {
          childMaySubmit.resolve();
          await until(() => f.coordination.reviewNotifications(f.root.id).length, 'Review notification was not staged.');
        }
        return [text('Initial answer')];
      }
      assert.equal(notices, 1);
      if (calls(request, 'tasks').length === 1) return [team('tasks', { action: 'accept', task: '#1' })];
      return [text('Review accepted')];
    });
    try {
      const events: AgentStreamEvent[] = [];
      const initial = await f.coordinator.start(f.root, input('Delegate a review'), options, (event) => events.push(event));
      let reviewRun = initial;
      if (delivery === 'idle reviewer') {
        assert.equal(initial.finalOutput, 'Initial answer');
        childMaySubmit.resolve();
        reviewRun = await until(() => f.root.runs.find((run) => run.id !== initial.id && run.status === 'completed'), 'Reviewer did not wake.');
        assert.equal(f.root.runs.length, 2);
      } else {
        assert.equal(f.root.runs.length, 1);
        assert.equal(events.filter((event) => event.type === 'response.created').length, 1);
        assert.ok(events.some((event) => event.type === 'response.output_item.done' && event.response_id === initial.id &&
          event.item.type === 'message' && event.item.role === 'user' && event.item.source?.kind === 'runtime'));
      }
      assert.equal(reviewRun.finalOutput, 'Review accepted');
      const delivered = delivery === 'active run' ? reviewRun.timeline : reviewRun.input;
      assert.equal(delivered.filter((item) => item.type === 'message' && item.role === 'user' && item.source?.kind === 'runtime' &&
        item.content.some((part) => part.type === 'text' && part.text === reviewText)).length, 1);
      assert.equal(f.coordination.reviewNotifications(f.root.id).length, 0);
    } finally {
      childMaySubmit.resolve();
      await f.close();
    }
  });
}

test('interrupting a waiting child cancels its current work and allows explicit redelegation', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) {
      if (requestText(request).includes('Begin task #2: Replacement')) return [text('Replacement submitted')];
      return [team('wait', { action: 'start', condition: { kind: 'mail', purpose: 'urgent' }, timeoutMs: 20000 })];
    }
    const taskCalls = calls(request, 'tasks');
    if (taskCalls.length < 2) return [publish(taskCalls.length === 0 ? 'Pause' : 'Replacement')];
    const delegations = calls(request, 'delegate_task');
    if (delegations.length === 0) return [call('delegate_task', { task: '#1', target: { kind: 'create', role: 'review', name: 'Reviewer' } })];
    const waits = calls(request, 'wait');
    if (waits.length === 0) return [team('wait', { action: 'start', condition: { kind: 'agent_state', agent: '@Reviewer', states: ['waiting'] } })];
    if (!calls(request, 'interrupt_agent').length) {
      assert.equal(toolOutput<{ state: string }>(request, 'wait').state, 'waiting');
      return [call('interrupt_agent', { agent: '@Reviewer' })];
    }
    if (delegations.length === 1) {
      assert.deepEqual(toolOutput(request, 'interrupt_agent'), { stopped: true });
      return [call('delegate_task', { task: '#2', target: { kind: 'agent', agent: '@Reviewer' } })];
    }
    if (waits.length === 1) return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#2', states: ['review_required'] } })];
    if (taskCalls.length === 2) return [team('tasks', { action: 'accept', task: '#2' })];
    return [text('Finished')];
  });
  try {
    const run = await f.coordinator.start(f.root, input('Interrupt and reassign'), options);
    assert.equal(run.status, 'completed');
    const [first, second] = f.coordination.tasks(f.root.id);
    assert.equal(first?.status, 'cancelled');
    assert.equal(first?.attempt?.reason, 'Agent was interrupted.');
    assert.equal(second?.status, 'completed');
    assert.equal(second?.attempt?.ownerSessionId, first?.attempt?.ownerSessionId);
    const child = (await f.workspace.getSession(second!.attempt!.ownerSessionId, owner))!;
    assert.equal(f.coordination.isStopped(child.id), false);
    assert.equal(f.coordination.wait(child.id), undefined);
    assert.deepEqual(child.runs.map(({ status }) => status), ['cancelled', 'completed']);
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
        assert.doesNotMatch(requestText(request), /unsolicited question/, 'The interruption stays in the tool result.');
        assert.doesNotMatch(requestText(request), /the needed answer/, 'The matched mail is delivered through the wait tool.');
        return [text('Task final after ' + mode)];
      }
      if (waits.length) {
        const result = toolOutput<{ status: string; messages: { body: string; author: string }[] }>(request, 'wait');
        assert.equal(result.status, 'interrupted');
        assert.deepEqual(result.messages.map(({ body, author }) => ({ body, author })), [{ body: 'unsolicited question', author: 'model' }]);
        assert.doesNotMatch(requestText(request), /unsolicited question/);
        assert.equal(requestText(request).split('> background progress').length - 1, 1);
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

test('automatic tasks without an idle matching child report the shortage without creating an agent', async () => {
  const f = await fixture(async (request) => {
    if (!calls(request, 'tasks').length) return [team('tasks', { action: 'publish', ...taskDraft('Needs a reviewer'), autoAssign: true })];
    const published = toolOutput<{ status: string; pendingReason: string; message: string }>(request, 'tasks');
    assert.equal(published.status, 'pending');
    assert.equal(published.pendingReason, 'no_idle_agent');
    assert.match(published.message, /role "review"/);
    if (!calls(request, 'wait').length) return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#1', states: ['review_required'] } })];
    const waiting = toolOutput<{ status: string; task: string; role: string }>(request, 'wait');
    assert.deepEqual([waiting.status, waiting.task, waiting.role], ['needs_agent', '#1', 'review']);
    return [text('Waiting for a reviewer')];
  });
  try {
    const run = await f.coordinator.start(f.root, input('Publish without a reviewer'), options);
    assert.equal(run.status, 'completed');
    const snapshot = await f.coordinator.snapshot(f.root);
    assert.equal(snapshot.members.length, 1);
    assert.equal(snapshot.tasks?.[0]?.pendingReason, 'no_idle_agent');
    assert.equal(snapshot.tasks?.[0]?.status, 'pending');
  } finally { await f.close(); }
});

test('retiring a child frees a slot and keeps its submitted result through restart', async () => {
  const f = await fixture(async (request) => {
    if (isChild(request)) return [text('Review submitted')];
    const tasks = calls(request, 'tasks');
    const delegates = calls(request, 'delegate_task');
    const waits = calls(request, 'wait');
    if (tasks.length < 2) return [publish(tasks.length ? 'Second review' : 'First review')];
    if (!delegates.length) return [call('delegate_task', { task: '#1', target: { kind: 'create', role: 'review', name: 'First reviewer' } })];
    if (!waits.length) return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#1', states: ['review_required'] } })];
    const createReplacement = () => call('delegate_task', { task: '#2', target: { kind: 'create', role: 'review', name: 'Replacement' } });
    if (delegates.length === 1) return [createReplacement()];
    if (!calls(request, 'retire_agent').length) {
      assert.match(toolResult(request, delegates[1]?.callId).envelope.error ?? '', /At most 12/);
      return [call('retire_agent', { agent: '@First reviewer' })];
    }
    assert.deepEqual(toolOutput(request, 'retire_agent'), { agent: '@First reviewer', retired: true });
    if (tasks.length === 2) return [team('tasks', { action: 'accept', task: '#1' })];
    if (delegates.length === 2) return [createReplacement()];
    assert.equal(toolOutput<{ attempt: { agent: string } }>(request, 'delegate_task').attempt.agent, '@Replacement');
    if (waits.length === 1) return [team('wait', { action: 'start', condition: { kind: 'task_state', task: '#2', states: ['review_required'] } })];
    if (tasks.length === 3) return [team('tasks', { action: 'accept', task: '#2' })];
    return [text('Both reviews accepted')];
  });
  try {
    for (let i = 0; i < 11; i += 1) await childOf(f, `Reserve ${i}`);
    const run = await f.coordinator.start(f.root, input('Rotate reviewers'), options);
    assert.equal(run.status, 'completed');
    const [first, second] = f.coordination.tasks(f.root.id);
    assert.equal(first?.attempt?.result?.output, 'Review submitted');
    assert.equal(second?.status, 'completed');
    await f.restart();
    const retired = await f.coordinator.directory.resolve(f.root, '@First reviewer');
    assert.equal(retired.id, first?.attempt?.ownerSessionId);
    assert.equal(f.coordination.isRetired(retired.id), true);
    assert.equal(retired.runs[0]?.finalOutput, 'Review submitted');
    assert.equal((await f.coordinator.directory.list(f.root)).find(({ agent }) => agent === '@First reviewer')?.status, 'retired');
    assert.throws(() => post(f, f.root.id, retired.id, 'Wake up', 'question'), /retired/);
  } finally { await f.close(); }
});

test('automatic assignment uses idle matching agents and reuses sessions for newly ready work', async () => {
  const f = await fixture(async (request) => [text(isChild(request) ? 'Child result' : 'Root')]);
  try {
    await f.coordinator.start(f.root, input('Plan'), options);
    const root = f.root.id;
    const first = f.coordination.createTask(root, root, { ...taskDraft('First', 'Read the initial file.'), autoAssign: true }, 'first');
    const second = f.coordination.createTask(root, root, { ...taskDraft('Second', 'Read the next file.'), autoAssign: true, blockedBy: [first.id] }, 'second');
    const general = await f.workspace.createSession(owner, { parentSessionId: root, projectId: f.project.id });
    assert.equal(f.coordination.task(root, first.id)?.status, 'pending');
    const review = await childOf(f, 'Reviewer');
    await until(() => f.coordination.task(root, first.id)?.status === 'review_required', 'The matching reviewer was not assigned.');
    assert.equal(f.coordination.task(root, first.id)?.attempt?.ownerSessionId, review.id);
    assert.equal(f.coordination.task(root, second.id)?.status, 'pending');
    assert.equal(general.runs.length, 0);
    const firstAttempt = f.coordination.task(root, first.id)?.attempt?.id;
    f.coordination.decideTask(root, first.id, root, { kind: 'reject', reason: 'Include the error path.' });
    await until(() => {
      const task = f.coordination.task(root, first.id);
      return task?.status === 'review_required' && task.attempt?.id !== firstAttempt;
    }, 'The rejected task was not assigned again.');
    f.coordination.decideTask(root, first.id, root, { kind: 'accept' });
    await until(() => f.coordination.task(root, second.id)?.status === 'review_required', 'The dependency did not unlock scheduling.');
    assert.equal(f.coordination.task(root, second.id)?.attempt?.ownerSessionId, review.id);
    const deliveries = review.runs.map((run) => run.input.flatMap(({ content }) =>
      content.flatMap((part) => part.type === 'text' ? [part.text] : [])));
    assert.equal(deliveries.length, 3);
    assert.match(deliveries[0]![0]!, /Role selected by @parent/);
    assert.match(deliveries[0]![1]!, /Begin task #1: First[\s\S]*Read the initial file\./);
    assert.equal(deliveries[1]?.length, 1);
    assert.match(deliveries[1]![0]!, /Begin task #1: First[\s\S]*Previous attempt \(rejected\): Include the error path\./);
    assert.equal(deliveries[2]?.length, 1);
    assert.match(deliveries[2]![0]!, /Begin task #2: Second[\s\S]*Read the next file\./);
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
    const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" -e "console.log(123); setTimeout(() => {}, 1500)"`;
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
