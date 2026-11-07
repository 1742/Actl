import assert from 'node:assert/strict';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentProcessHost } from '../../src/main/agent-process-host';
import type { AgentCommand, AgentResult } from '../../src/shared/agent-ipc';
import { runCoreChecks } from './core-checks';
import type { VerificationCheck } from './types';
import type { AgentResponseDto, AgentStreamEvent } from '../../src/shared/agent/responses';
import type { SessionReview } from '../../src/shared/agent/review';
import type { WorkspaceFilePreview } from '../../src/shared/agent/workspace';

// This loopback provider exists only behind --verify-agent. It never forwards requests.
async function startFixture(processCommands: Map<string, string>) {
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ role: string; content: unknown }> };
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
      if (text.includes('slow-fixture')) {
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
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export async function verifyAgent(root: string, packaged: boolean, forcedExitProbe = false) {
  const homeDirectory = path.join(root, 'agent-home');
  const workspace = path.join(root, '中文 workspace');
  await mkdir(workspace, { recursive: true });
  const processCommands = new Map<string, string>();
  const fixture = await startFixture(processCommands);
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
  const run = (text: string, onEvents?: (events: AgentStreamEvent[]) => void) => host.request({
    operation: 'responses.create', params: { sessionId }, body: {
      model, permissionMode: 'ask', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
    },
  }, onEvents);
  const success = (result: AgentResult): AgentResponseDto => { assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error)); return result.value as AgentResponseDto; };
  const resume = async (run: AgentResponseDto, decision: 'approve' | 'deny') => {
    const batch = run.pending_permission_batch; assert.ok(batch);
    return request<AgentResponseDto>({ operation: 'responses.permissions', params: { sessionId, responseId: run.id }, body: {
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
      const cancelled = await request<AgentResponseDto>({ operation: 'responses.cancel', params: { sessionId, responseId: slow.id } });
      assert.equal(cancelled.status, 'cancelled'); assert.equal(success(await slow.running).status, 'cancelled');
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
