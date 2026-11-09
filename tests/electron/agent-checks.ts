import assert from 'node:assert/strict';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { AgentProcessHost } from '../../src/main/agent-process-host';
import type { AgentCommand, AgentResult } from '../../src/shared/agent-ipc';
import { runCoreChecks } from './core-checks';
import type { VerificationCheck } from './types';
import type { AgentResponseDto, AgentStreamEvent, ResponseInputPartDto } from '../../src/shared/agent/responses';
import type { AgentProject } from '../../src/shared/agent/sessions';
import type { SessionReview } from '../../src/shared/agent/review';
import type { AgentTreeEvent, AgentTreeSnapshot } from '../../src/shared/agent/coordination';
import type { RuntimeProjectFileSearchResult, RuntimeWorkspaceFileSearchResult, RuntimeWorkspaceTree, WorkspaceFilePreview } from '../../src/shared/agent/workspace';

type FixtureMessage = { role: string; content: unknown };

// This loopback provider exists only behind --verify-agent. It never forwards requests.
async function startFixture(processCommands: Map<string, string>, explicitWorkspace: string) {
  let workspaceMessages: FixtureMessage[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { messages: FixtureMessage[] };
      const user = payload.messages.filter((message) => message.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const id = `fixture-${randomUUID()}`;
      const emit = (delta: object, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 1, model: 'local-fixture',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
      const done = () => { response.write('data: [DONE]\n\n'); response.end(); };
      emit({ role: 'assistant' });
      if (text.includes('multi-child-fixture')) {
        emit({ content: 'child running' });
        const timer = setTimeout(() => { emit({ content: ' child result ready' }, 'stop'); done(); }, 350);
        response.once('close', () => clearTimeout(timer));
      } else if (text.includes('multi-root-fixture') && payload.messages.at(-1)?.role !== 'tool') {
        emit({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: {
          name: 'spawn_agent', arguments: JSON.stringify({ title: 'Background reviewer', prompt: 'multi-child-fixture' }),
        } }] }, 'tool_calls');
        done();
      } else if (text.includes('workspace-shell-') && payload.messages.at(-1)?.role !== 'tool') {
        workspaceMessages = payload.messages;
        emit({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: {
          name: 'shell', arguments: JSON.stringify({ command: 'cd', ...(text.includes('workspace-shell-explicit') ? { cwd: explicitWorkspace } : {}) }),
        } }] }, 'tool_calls');
        done();
      } else if (text.includes('slow-fixture')) {
        emit({ content: 'Waiting' });
        const timer = setTimeout(() => { emit({ content: ' complete' }, 'stop'); done(); }, 8_000);
        response.once('close', () => clearTimeout(timer));
      } else if (text.includes('mcp-fixture') && payload.messages.at(-1)?.role !== 'tool') {
        emit({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: {
          name: 'call_mcp_tool', arguments: JSON.stringify({ toolName: 'mcp__fixture__add', arguments: { a: 19, b: 23 } }),
        } }] }, 'tool_calls');
        done();
      } else if (text.includes('process-fixture:') && payload.messages.at(-1)?.role !== 'tool') {
        const label = /process-fixture:([a-z-]+)/.exec(text)?.[1];
        const command = label && processCommands.get(label); assert.ok(command);
        emit({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: {
          name: 'shell', arguments: JSON.stringify({ command, yieldTimeMs: 1_000 }),
        } }] }, 'tool_calls');
        done();
      } else if (text.includes('review-fixture') && payload.messages.at(-1)?.role !== 'tool') {
        const toolCalls = [
          { name: 'write_file', arguments: JSON.stringify({ path: 'review.txt', content: 'intermediate\n' }) },
          { name: 'apply_patch', arguments: JSON.stringify({ patches: [{
            path: 'review.txt', replacements: [{ oldText: 'intermediate', newText: 'final', expectedOccurrences: 1 }],
          }] }) },
        ];
        emit({ tool_calls: toolCalls.map((fn, index) => ({
          index, id: `call-${randomUUID()}`, type: 'function', function: fn,
        })) }, 'tool_calls');
        done();
      } else if (text.includes('write-fixture:') && payload.messages.at(-1)?.role !== 'tool') {
        const file = /write-fixture:([a-z-]+\.txt)/.exec(text)?.[1];
        assert.ok(file);
        emit({ tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ path: file, content: 'approved by IPC' }),
        } }] }, 'tool_calls');
        done();
      } else { emit({ content: '迁移' }); emit({ content: '验证通过' }, 'stop'); done(); }
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end('Local fixture rejected the request.');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, workspaceMessages: () => workspaceMessages, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export async function verifyAgent(root: string, packaged: boolean, forcedExitProbe = false) {
  const homeDirectory = path.join(root, 'agent-home');
  const workspace = path.join(root, '中文 workspace');
  const secondaryWorkspace = path.join(root, 'secondary workspace');
  await mkdir(workspace, { recursive: true });
  const processCommands = new Map<string, string>();
  const fixture = await startFixture(processCommands, workspace);
  const fixturePids = new Set<number>();
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitFor = async (condition: () => Promise<boolean> | boolean, message: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(message);
  };
  const options = { homeDirectory, mode: packaged ? 'release' as const : 'development' as const };
  let host = new AgentProcessHost(options);
  const checks: VerificationCheck[] = [];
  const fixturePath = packaged ? path.join(process.resourcesPath, 'verification-fixtures/mcp-server.cjs')
    : path.join(app.getAppPath(), 'out/fixtures/mcp-server.cjs');
  const step = async (name: string, operation: () => Promise<void>) => {
    const start = performance.now();
    try { await operation(); checks.push({ name, passed: true, durationMs: Math.round(performance.now() - start) }); }
    catch (error) { checks.push({ name, passed: false, durationMs: Math.round(performance.now() - start), error: error instanceof Error ? error.message : String(error) }); throw error; }
  };
  const request = async <T>(command: AgentCommand): Promise<T> => {
    const result = await host.request(command);
    assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
    return result.value as T;
  };
  let projectId = ''; let sessionId = ''; let model = '';
  const run = (text: string, onEvents?: (events: AgentStreamEvent[]) => void, targetId = sessionId) => host.request({
    operation: 'responses.create', params: { sessionId: targetId }, body: {
      model, permissionMode: 'ask', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    },
  }, onEvents);
  const success = (result: AgentResult): AgentResponseDto => { assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error)); return result.value as AgentResponseDto; };
  const resume = async (run: AgentResponseDto, decision: 'approve' | 'deny', targetId = sessionId) => {
    const batch = run.pending_permission_batch; assert.ok(batch);
    return request<AgentResponseDto>({ operation: 'responses.permissions', params: { sessionId: targetId, responseId: run.id }, body: {
      batchId: batch.id, decisions: batch.permissions.map((permission) => ({ permission_id: permission.id, decision })),
    } });
  };
  const launchOrphan = async (label: string) => {
    const marker = path.join(root, `${label}.json`);
    const script = fixturePath;
    processCommands.set(label, `set "ELECTRON_RUN_AS_NODE=1" && "${process.execPath}" "${script}" --orphan-probe "${marker}"`);
    const pending = success(await run(`process-fixture:${label}`));
    assert.equal(pending.status, 'waiting_permission');
    assert.equal((await resume(pending, 'approve')).status, 'completed');
    let info: { pid: number; parentPid: number } | undefined;
    await waitFor(async () => {
      info = await readFile(marker, 'utf8').then((text) => JSON.parse(text), () => undefined);
      return !!info;
    }, 'Shell did not launch the detached fixture.');
    fixturePids.add(info!.pid);
    await waitFor(() => !alive(info!.parentPid), 'Fixture launcher did not exit.');
    assert.ok(alive(info!.pid), 'Detached descendant must be alive before cleanup.');
    return info!.pid;
  };
  let passed = false;
  try {
    if (!forcedExitProbe) {
      checks.push(...await runCoreChecks(path.join(root, 'core-中文 空格'), fixturePath));
      assert.ok(checks.every((check) => check.passed), 'Core checks failed.');
    }
    await step('Agent startup, project/session creation and local credentials', async () => {
      const info = await host.ready(); assert.equal(info.ownerId, 'developer:local');
      assert.ok(host.pid && host.pid !== process.pid, 'Agent must run in a separate utility process.');
      projectId = (await request<{ id: string }>({ operation: 'projects.create', body: { cwd: workspace } })).id;
      sessionId = (await request<{ id: string }>({ operation: 'sessions.create', body: { projectId } })).id;
      const account = await request<{ id: string; hasCredential: boolean }>({ operation: 'accounts.create', body: {
        displayName: 'Local fixture', baseURL: fixture.baseURL, apiKey: 'synthetic-local-fixture-only',
      } }); assert.equal(account.hasCredential, true);
      model = (await request<{ id: string }>({ operation: 'models.create', params: { accountId: account.id }, body: {
        providerModel: 'local-fixture', displayName: 'Local fixture', protocol: 'chat_completions',
      } })).id;
      const listed = await request<Array<{ id: string }>>({ operation: 'sessions.list' });
      assert.ok(listed.some((session) => session.id === sessionId));
    });
    if (forcedExitProbe) {
      const pid = await launchOrphan('main-exit-orphan');
      await writeFile(path.join(root, 'forced-exit-ready.json'), JSON.stringify({ pid }));
      // The outer verifier terminates only this main process, without taskkill /T.
      await new Promise<never>(() => {});
    }
    await step('Standalone workspaces isolate files and persist across restarts and deletion', async () => {
      const workspaceRoot = path.join(homeDirectory, 'workspaces', options.mode);
      const create = () => request<{ id: string; projectId: null }>({ operation: 'sessions.create' });
      const first = await create();
      const second = await create();
      assert.equal(first.projectId, null);
      assert.equal(second.projectId, null);
      assert.notEqual(first.id, second.id);
      const firstCwd = path.join(workspaceRoot, first.id);
      const secondCwd = path.join(workspaceRoot, second.id);
      await Promise.all([access(firstCwd), access(secondCwd)]);

      const pendingWrite = success(await run('write-fixture:standalone.txt', undefined, first.id));
      assert.equal((await resume(pendingWrite, 'approve', first.id)).status, 'completed');
      assert.equal(await readFile(path.join(firstCwd, 'standalone.txt'), 'utf8'), 'approved by IPC');
      await assert.rejects(access(path.join(secondCwd, 'standalone.txt')), { code: 'ENOENT' });
      processCommands.set('standalone-cwd', 'echo standalone>shell-cwd.txt');
      const pendingShell = success(await run('process-fixture:standalone-cwd', undefined, second.id));
      assert.equal((await resume(pendingShell, 'approve', second.id)).status, 'completed');
      assert.equal((await readFile(path.join(secondCwd, 'shell-cwd.txt'), 'utf8')).trim(), 'standalone');
      await assert.rejects(access(path.join(firstCwd, 'shell-cwd.txt')), { code: 'ENOENT' });

      const oldBind = await host.request({
        operation: 'sessions.bind' as AgentCommand['operation'], params: { sessionId: first.id }, body: { projectId },
      });
      assert.equal(oldBind.ok, false);

      const list = () => request<Array<{ id: string }>>({ operation: 'sessions.list' });
      const before = await list();
      const parkedRoot = workspaceRoot + '-parked';
      await rename(workspaceRoot, parkedRoot);
      try {
        await writeFile(workspaceRoot, '', { flag: 'wx' });
        try {
          assert.equal((await host.request({ operation: 'sessions.create' })).ok, false);
          assert.deepEqual(await list(), before);
        } finally {
          await unlink(workspaceRoot);
        }
      } finally {
        await rename(parkedRoot, workspaceRoot);
      }

      await host.close();
      // A session row created before the workspace feature has no directory on disk.
      const legacyId = `session_${randomUUID()}`;
      const database = new DatabaseSync(path.join(homeDirectory, 'database', options.mode, 'workspace.db'));
      try {
        const now = new Date().toISOString();
        const ownerId = (database.prepare('SELECT owner_id FROM sessions WHERE id = ?').get(first.id))?.owner_id;
        assert.ok(typeof ownerId === 'string');
        database.prepare('INSERT INTO sessions(id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(legacyId, ownerId, now, now);
      } finally {
        database.close();
      }
      host = new AgentProcessHost(options);
      await host.ready();
      const legacyCwd = path.join(workspaceRoot, legacyId);
      await assert.rejects(access(legacyCwd), { code: 'ENOENT' });
      await request({ operation: 'sessions.context', params: { sessionId: legacyId } });
      await access(legacyCwd);
      await request({ operation: 'sessions.context', params: { sessionId: first.id } });
      assert.equal(await readFile(path.join(firstCwd, 'standalone.txt'), 'utf8'), 'approved by IPC');
      await request({ operation: 'sessions.delete', params: { sessionId: first.id } });
      assert.ok(!(await list()).some((session) => session.id === first.id));
      assert.equal(await readFile(path.join(firstCwd, 'standalone.txt'), 'utf8'), 'approved by IPC');
    });
    await step('IPC validation, attachment round trip and session ownership', async () => {
      const invalid = await host.request({ operation: 'projects.create', body: { cwd: '' } });
      assert.equal(invalid.ok, false); if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_request');
      const file = await request<{ id: string }>({ operation: 'files.upload', params: { sessionId }, body: {
        filename: '中文.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('附件验证'),
      } });
      const content = await request<{ bytes: Uint8Array }>({ operation: 'files.content', params: { sessionId, fileId: file.id } });
      assert.equal(new TextDecoder().decode(content.bytes), '附件验证');
      const other = await request<{ id: string }>({ operation: 'sessions.create' });
      const rejected = await host.request({ operation: 'files.content', params: { sessionId: other.id, fileId: file.id } });
      assert.equal(rejected.ok, false);
    });
    await step('Workspace preview returns text and image bytes within project boundaries', async () => {
      const source = 'const message = "中文";\r\n';
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHj8AAAAASUVORK5CYII=', 'base64');
      await writeFile(path.join(workspace, '源码.ts'), source);
      await writeFile(path.join(workspace, 'preview.png'), image);
      await writeFile(path.join(workspace, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
      await writeFile(path.join(workspace, 'binary.bin'), Buffer.from([0, 255, 1]));
      await writeFile(path.join(root, 'outside.txt'), 'outside the project');
      const preview = (file: string) => request<WorkspaceFilePreview>({
        operation: 'workspace.preview', params: { projectId }, query: { path: file },
      });
      assert.deepEqual(await preview('源码.ts'), { kind: 'text', text: source });
      assert.deepEqual(await preview('preview.png'), { kind: 'image', mediaType: 'image/png', bytes: new Uint8Array(image) });
      assert.deepEqual(await preview('missing.txt'), { kind: 'missing' });
      assert.deepEqual(await preview('large.txt'), { kind: 'too-large' });
      assert.deepEqual(await preview('binary.bin'), { kind: 'unsupported' });
      await assert.rejects(preview('../outside.txt'));
    });
    await step('Last-run review persists net changes from both file tools', async () => {
      const review = (fileId?: string) => request<SessionReview>({
        operation: 'sessions.review', params: { sessionId }, ...(fileId ? { query: { fileId } } : {}),
      });
      await writeFile(path.join(workspace, 'review.txt'), 'original\n');
      const pending = success(await run('review-fixture'));
      assert.equal(pending.status, 'waiting_permission');
      assert.deepEqual((await review()).files, []);
      const completed = await resume(pending, 'approve');
      assert.equal(completed.status, 'completed');
      assert.equal(await readFile(path.join(workspace, 'review.txt'), 'utf8'), 'final\n');
      await host.close();
      host = new AgentProcessHost(options);
      await host.ready();
      const saved = await review();
      assert.equal(saved.runId, completed.id);
      assert.equal(saved.files.length, 1);
      const file = saved.files[0]!;
      assert.deepEqual({ ...file, id: '' }, {
        id: '', path: 'review.txt', additions: 1, deletions: 1, unavailable: false,
      });
      assert.deepEqual((await review(file.id)).lines, [
        { kind: 'removed', text: 'original\n', oldLine: 1 },
        { kind: 'added', text: 'final\n', newLine: 1 },
      ]);
    });
    await step('Streaming text, event ordering and persisted history', async () => {
      const events: Array<{ type: string; sequence_number: number }> = [];
      const result = success(await run('text-fixture', (batch) => events.push(...batch as typeof events)));
      assert.equal(result.status, 'completed');
      assert.ok(events.some((event) => event.type === 'response.output_text.delta'));
      assert.equal(events[0]?.type, 'response.created');
      assert.equal(events.at(-1)?.type, 'response.completed');
      for (let index = 1; index < events.length; index++) assert.ok(events[index]!.sequence_number > events[index - 1]!.sequence_number);
      const context = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId } });
      assert.ok(context.responses.some((response) => response.id === result.id && response.status === 'completed'));
    });
    await step('Tool approval, denial and rejection of stale decisions', async () => {
      const pending = success(await run('write-fixture:approved.txt'));
      assert.equal(pending.status, 'waiting_permission');
      assert.equal(await access(path.join(workspace, 'approved.txt')).then(() => true, () => false), false);
      const completed = await resume(pending, 'approve'); assert.equal(completed.status, 'completed');
      assert.equal(await readFile(path.join(workspace, 'approved.txt'), 'utf8'), 'approved by IPC');
      await assert.rejects(() => resume(pending, 'approve'));
      const denied = success(await run('write-fixture:denied.txt'));
      assert.equal((await resume(denied, 'deny')).status, 'completed');
      assert.equal(await access(path.join(workspace, 'denied.txt')).then(() => true, () => false), false);
    });
    await step('MCP configuration, tool approval, invocation and process cleanup', async () => {
      const config = { command: process.execPath, args: [fixturePath], env: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true };
      const tested = await request<{ tools: Array<{ name: string }> }>({ operation: 'mcp.test', body: { name: 'fixture', config } });
      assert.ok(tested.tools.some((tool) => tool.name.endsWith('__add')));
      await request({ operation: 'mcp.save', params: { name: 'fixture' }, body: config });
      const catalog = await request<{ servers: Array<{ name: string; connected: boolean }> }>({ operation: 'mcp.catalog' });
      assert.ok(catalog.servers.some((server) => server.name === 'fixture' && server.connected));
      const pending = success(await run('mcp-fixture')); assert.equal(pending.status, 'waiting_permission');
      const completed = await resume(pending, 'approve'); assert.equal(completed.status, 'completed');
      const result = completed.output.find((item) => item.type === 'function_call_output');
      assert.ok(result && result.type === 'function_call_output');
      const envelope = JSON.parse(result.output) as { ok: boolean; output: { content: Array<{ type: string; text: string }> } };
      assert.equal(envelope.ok, true);
      const value = JSON.parse(envelope.output.content.find((part) => part.type === 'text')!.text) as { sum: number; pid: number; node: string };
      fixturePids.add(value.pid);
      assert.equal(value.sum, 42); assert.equal(value.node, process.versions.node); assert.ok(alive(value.pid));
      await request({ operation: 'mcp.delete', params: { name: 'fixture' } });
      await waitFor(() => !alive(value.pid), 'MCP server survived removal.');
      fixturePids.delete(value.pid);
    });
    await step('Pending approvals and encrypted model configuration survive restart', async () => {
      const pending = success(await run('write-fixture:restart.txt')); assert.equal(pending.status, 'waiting_permission');
      await host.close(); host = new AgentProcessHost(options); await host.ready();
      const context = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId } });
      const restored = context.responses.find((response) => response.id === pending.id); assert.ok(restored);
      assert.equal(restored.status, 'waiting_permission'); assert.equal((await resume(restored, 'approve')).status, 'completed');
      assert.equal(await readFile(path.join(workspace, 'restart.txt'), 'utf8'), 'approved by IPC');
    });
    const startSlow = async () => {
      let created!: (id: string) => void;
      const started = new Promise<string>((resolve) => { created = resolve; });
      const running = run('slow-fixture', (events) => {
        for (const value of events) { const event = value as { type: string; response_id: string }; if (event.type === 'response.created') created(event.response_id); }
      });
      const id = await started; await new Promise((resolve) => setTimeout(resolve, 100));
      return { id, running };
    };
    await step('Project concurrency conflict and explicit cancellation', async () => {
      const slow = await startSlow();
      const other = await request<{ id: string }>({ operation: 'sessions.create', body: { projectId } });
      const conflict = await host.request({ operation: 'responses.create', params: { sessionId: other.id }, body: {
        model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'conflict-fixture' }] }],
      } });
      assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, 'project_active_response_exists');
      const edit = await host.request({ operation: 'projects.update', params: { projectId }, body: {
        workspacePaths: [workspace], primaryWorkspacePath: workspace,
      } });
      assert.equal(edit.ok, false); if (!edit.ok) assert.equal(edit.error.code, 'project_active_response_exists');
      const cancelled = await request<AgentResponseDto>({ operation: 'responses.cancel', params: { sessionId, responseId: slow.id } });
      assert.equal(cancelled.status, 'cancelled'); assert.equal(success(await slow.running).status, 'cancelled');
      const next = await startSlow();
      assert.equal((await request<AgentResponseDto>({ operation: 'responses.cancel', params: { sessionId, responseId: slow.id } })).status, 'cancelled');
      const context = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId } });
      assert.equal(context.responses.find((response) => response.id === next.id)?.status, 'in_progress', 'Retrying an old cancellation must not stop a new run.');
      await request({ operation: 'responses.cancel', params: { sessionId, responseId: next.id } });
      assert.equal(success(await next.running).status, 'cancelled');
    });
    await step('Background agent tree subscription, detach, follow-up and restart persistence', async () => {
      const rootSession = await request<{ id: string }>({ operation: 'sessions.create', body: { projectId } });
      const events: AgentTreeEvent[] = [];
      const subscription = randomUUID();
      assert.ok((await host.watchTree(subscription, rootSession.id, (event) => events.push(event))).ok);
      assert.equal(events[0]?.type, 'snapshot');
      assert.equal(success(await run('multi-root-fixture', undefined, rootSession.id)).status, 'completed');
      await waitFor(async () => {
        const tree = await request<AgentTreeSnapshot>({ operation: 'agents.tree', params: { sessionId: rootSession.id } });
        return tree.members.length === 2 && tree.members.every((member) => member.response?.status === 'completed');
      }, 'Background child did not complete.');
      await waitFor(() => events.some((event) => event.type === 'response' && event.sessionId !== rootSession.id && event.events.some((item) => item.type === 'response.completed')), 'Tree subscription missed background completion.');
      const tree = await request<AgentTreeSnapshot>({ operation: 'agents.tree', params: { sessionId: rootSession.id } });
      const child = tree.members.find((member) => member.session.parentSessionId === rootSession.id)!;
      assert.ok(child);
      host.detach(subscription);
      const count = events.length;
      await request({ operation: 'agents.message', params: { sessionId: rootSession.id }, body: { targetSessionId: child.session.id, message: 'Continue with a short summary.' } });
      await waitFor(async () => {
        const context = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId: child.session.id } });
        return context.responses.length === 2 && context.responses[1]?.status === 'completed';
      }, 'Idle child did not resume after a follow-up.');
      assert.equal(events.length, count, 'Detached subscription received more events.');
      // Stop any queued root follow-up before checking process restart persistence.
      await request({ operation: 'agents.stop', params: { sessionId: rootSession.id } });
      await host.close(); host = new AgentProcessHost(options); await host.ready();
      const restored = await request<AgentTreeSnapshot>({ operation: 'agents.tree', params: { sessionId: rootSession.id } });
      assert.equal(restored.members.length, 2);
      assert.equal(restored.members.find((member) => member.session.id === child.session.id)?.session.parentSessionId, rootSession.id);
    });
    await step('Unexpected runtime exit fails in-flight calls and recovers history', async () => {
      const orphanPid = await launchOrphan('crash-orphan');
      const slow = await startSlow(); const pid = host.pid; assert.ok(pid);
      process.kill(pid, 'SIGKILL');
      const interrupted = await slow.running; assert.equal(interrupted.ok, false);
      if (!interrupted.ok) assert.equal(interrupted.error.code, 'runtime_interrupted');
      await waitFor(() => !alive(orphanPid), 'Detached descendant survived Agent crash.');
      fixturePids.delete(orphanPid);
      host = new AgentProcessHost(options); await host.ready();
      const context = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId } });
      const recovered = context.responses.find((response) => response.id === slow.id); assert.ok(recovered);
      assert.equal(recovered.status, 'failed'); assert.equal(recovered.error?.code, 'runtime_interrupted');
    });
    await step('Restart removes descendants whose launcher already exited', async () => {
      const orphanPid = await launchOrphan('restart-orphan');
      await host.close();
      await waitFor(() => !alive(orphanPid), 'Detached descendant survived Agent shutdown.');
      fixturePids.delete(orphanPid);
      host = new AgentProcessHost(options); await host.ready();
      assert.equal(success(await run('text-fixture-after-process-cleanup')).status, 'completed');
    });
    await step('Project workspaces isolate browsing and pin file references across primary changes', async () => {
      await mkdir(secondaryWorkspace);
      await Promise.all([
        writeFile(path.join(workspace, 'same.txt'), 'primary'),
        writeFile(path.join(secondaryWorkspace, 'same.txt'), 'secondary'),
        writeFile(path.join(secondaryWorkspace, 'secondary-only.txt'), 'secondary'),
        writeFile(path.join(workspace, 'prefix-secondary-only.txt'), 'primary partial match'),
        writeFile(path.join(workspace, 'AGENTS.md'), 'fixture-primary-agents'),
        writeFile(path.join(workspace, 'instructions.md'), 'fixture-primary-instructions'),
        writeFile(path.join(secondaryWorkspace, 'AGENTS.md'), 'fixture-secondary-agents'),
        writeFile(path.join(secondaryWorkspace, 'instructions.md'), 'fixture-secondary-instructions'),
      ]);
      const setWorkspaces = (primaryWorkspacePath: string, workspacePaths = [workspace, secondaryWorkspace]): AgentCommand => ({
        operation: 'projects.update', params: { projectId }, body: { name: 'Multi workspace', workspacePaths, primaryWorkspacePath },
      });
      const current = await request<AgentProject[]>({ operation: 'projects.list' });
      const originalId = current.find(({ id }) => id === projectId)!.primaryWorkspaceId;
      const updated = await request<AgentProject>(setWorkspaces(workspace));
      assert.equal(updated.primaryWorkspaceId, originalId);
      const primaryParams = { projectId, workspaceId: originalId };
      const secondaryParams = { projectId, workspaceId: updated.workspaces[1]!.id };
      const reference = (params: { workspaceId: string }, file = 'same.txt'): ResponseInputPartDto => ({
        type: 'input_workspace_file', workspaceId: params.workspaceId, path: file,
      });
      const runWithRefs = (text: string, ...refs: ResponseInputPartDto[]): Promise<AgentResult> => host.request({
        operation: 'responses.create', params: { sessionId }, body: {
          model, permissionMode: 'ask', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }, ...refs] }],
        },
      });
      const expectError = async (response: Promise<AgentResult>, code: string) => {
        const failure = await response;
        assert.equal(failure.ok, false);
        if (!failure.ok) assert.equal(failure.error.code, code);
      };
      const preview = (params: { projectId: string; workspaceId?: string }) => request<WorkspaceFilePreview>({
        operation: 'workspace.preview', params, query: { path: 'same.txt' },
      });
      assert.deepEqual(await preview({ projectId }), { kind: 'text', text: 'primary' });
      assert.deepEqual(await preview(secondaryParams), { kind: 'text', text: 'secondary' });
      assert.equal(await request({ operation: 'workspace.projectDirectory', params: secondaryParams }), secondaryWorkspace);
      assert.equal(await request({ operation: 'workspace.revealTarget', params: secondaryParams, query: { path: 'same.txt' } }), path.join(secondaryWorkspace, 'same.txt'));
      assert.ok((await request<RuntimeWorkspaceTree>({ operation: 'workspace.tree', params: secondaryParams })).entries.some(({ name }) => name === 'secondary-only.txt'));
      const search = (params: typeof secondaryParams) => request<RuntimeWorkspaceFileSearchResult>({
        operation: 'workspace.search', params, query: { q: 'secondary-only' },
      });
      assert.equal((await search(primaryParams)).data[0]?.path, 'prefix-secondary-only.txt');
      assert.equal((await search(secondaryParams)).data[0]?.path, 'secondary-only.txt');
      const searchProject = (q: string, limit = '20') => request<RuntimeProjectFileSearchResult>({
        operation: 'workspace.searchProject', params: { projectId }, query: { q, limit },
      });
      const sameName = await searchProject('same.txt');
      assert.deepEqual(sameName.data.map(({ path: file, workspaceId, workspaceName }) => [file, workspaceId, workspaceName]), [
        ['same.txt', originalId, path.basename(workspace)],
        ['same.txt', secondaryParams.workspaceId, path.basename(secondaryWorkspace)],
      ]);
      const bestMatch = await searchProject('secondary-only.txt', '1');
      assert.equal(bestMatch.data[0]?.workspaceId, secondaryParams.workspaceId);
      assert.equal(bestMatch.truncated, true);
      const parkedWorkspace = secondaryWorkspace + '-offline';
      await rename(secondaryWorkspace, parkedWorkspace);
      try {
        const partial = await searchProject('same.txt');
        assert.deepEqual(partial.data.map(({ workspaceId }) => workspaceId), [originalId]);
        assert.equal(partial.truncated, true);
      } finally {
        await rename(parkedWorkspace, secondaryWorkspace);
      }

      const foreignDirectory = path.join(root, 'foreign workspace');
      await mkdir(foreignDirectory);
      const foreign = await request<AgentProject>({ operation: 'projects.create', body: { cwd: foreignDirectory } });
      await expectError(host.request(setWorkspaces(workspace, [workspace, workspace.toUpperCase()])), 'project_workspaces_invalid');
      await expectError(host.request(setWorkspaces(workspace, [workspace, foreignDirectory])), 'project_already_exists');
      await expectError(host.request(setWorkspaces(workspace, [secondaryWorkspace])), 'project_workspaces_invalid');
      await expectError(host.request({ operation: 'workspace.tree', params: { projectId, workspaceId: foreign.primaryWorkspaceId } }), 'workspace_not_found');
      await expectError(runWithRefs('wrong workspace', reference({ workspaceId: foreign.primaryWorkspaceId })), 'workspace_not_found');
      await expectError(runWithRefs('traversal', reference(secondaryParams, '../outside.txt')), 'invalid_workspace_file');

      const originalRun = success(await runWithRefs('workspace-shell-default', reference(primaryParams), reference(secondaryParams)));
      assert.equal(originalRun.status, 'waiting_permission');
      const originalInstructions = String(fixture.workspaceMessages()[0]?.content);
      assert.match(originalInstructions, /fixture-primary-agents[\s\S]*fixture-primary-instructions/);
      assert.doesNotMatch(originalInstructions, /fixture-secondary-(agents|instructions)/);
      assert.ok(originalInstructions.includes(secondaryWorkspace));
      await expectError(host.request(setWorkspaces(secondaryWorkspace)), 'project_active_response_exists');
      const shellCwd = (response: AgentResponseDto) => {
        const item = response.output.find(({ type }) => type === 'function_call_output');
        assert.ok(item && item.type === 'function_call_output');
        const result = JSON.parse(item.output) as { ok: boolean; output: { cwd: string; exitCode: number } };
        assert.ok(result.ok);
        assert.equal(result.output.exitCode, 0);
        return result.output.cwd;
      };
      assert.equal(shellCwd(await resume(originalRun, 'approve')), workspace);
      const switched = await request<AgentProject>(setWorkspaces(secondaryWorkspace));
      assert.equal(switched.primaryWorkspaceId, secondaryParams.workspaceId);
      assert.equal(switched.workspaces[0]?.id, originalId);
      assert.deepEqual(await preview({ projectId }), { kind: 'text', text: 'secondary' });
      assert.deepEqual(await preview(primaryParams), { kind: 'text', text: 'primary' });
      const explicit = success(await run('workspace-shell-explicit'));
      assert.equal(shellCwd(await resume(explicit, 'approve')), workspace);
      const next = success(await run('workspace-shell-default'));
      assert.equal(shellCwd(await resume(next, 'approve')), secondaryWorkspace);
      const messages = fixture.workspaceMessages();
      const nextInstructions = String(messages[0]?.content);
      assert.match(nextInstructions, /fixture-secondary-agents[\s\S]*fixture-secondary-instructions/);
      assert.doesNotMatch(nextInstructions, /fixture-primary-(agents|instructions)/);
      const absolutePaths = [workspace, secondaryWorkspace].map((directory) => path.join(directory, 'same.txt').split(path.sep).join('/'));
      const oldMessage = messages.find((message) => message.role === 'user' && Array.isArray(message.content) && message.content.length === 3);
      assert.deepEqual((oldMessage?.content as Array<{ text: string }>).slice(1).map(({ text }) => text), absolutePaths);

      await request(setWorkspaces(secondaryWorkspace, [secondaryWorkspace]));
      await expectError(host.request({ operation: 'workspace.tree', params: primaryParams }), 'workspace_not_found');
      await expectError(runWithRefs('removed workspace', reference(primaryParams)), 'workspace_not_found');
      await host.close(); host = new AgentProcessHost(options); await host.ready();
      const persisted = (await request<AgentProject[]>({ operation: 'projects.list' })).find(({ id }) => id === projectId)!;
      assert.deepEqual(persisted.workspaces, [switched.workspaces[1]]);
      assert.equal(persisted.cwd, secondaryWorkspace);
      const history = await request<{ responses: AgentResponseDto[] }>({ operation: 'sessions.context', params: { sessionId } });
      const historicalPaths = history.responses.find(({ id }) => id === originalRun.id)?.input[0]?.content
        .flatMap((part) => part.type === 'input_workspace_file' ? [part.path] : []);
      assert.deepEqual(historicalPaths, absolutePaths);
    });
    await step('Graceful shutdown', () => host.close());
    passed = true;
  } catch { /* The failed step is recorded without dumping request bodies or credentials. */ }
  finally {
    await host.close().catch(() => undefined);
    await fixture.close();
    for (const pid of fixturePids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
  }
  const report = { passed, packaged, versions: { electron: process.versions.electron, node: process.versions.node }, checks };
  await writeFile(path.join(root, 'agent-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
