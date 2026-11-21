import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunPermissionEngine } from '../../../src/agent-core/permissions/run-policy.js';
import { ProcessSupervisor } from '../../../src/agent-core/runtime/process/process-supervisor.js';
import { ShellToolProvider } from '../../../src/agent-core/tools/builtin/shell.js';
import type { ToolCallContext } from '../../../src/agent-core/tools/registry.js';
import type { ManagedProcessPoll } from '../../../src/agent-core/runtime/process/process-types.js';

test('workspace shell confines descendants and a host approval applies only to its command', { skip: process.platform !== 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'actl-shell-test-'));
  const cwd = path.join(fixture, 'project with spaces');
  mkdirSync(cwd);
  const previousRunner = process.env.ACTL_SHELL_RUNNER;
  process.env.ACTL_SHELL_RUNNER ??= path.resolve('out/main/windows-shell-runner.cjs');
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession('sandbox-test');
  const provider = new ShellToolProvider();
  const permissions = new RunPermissionEngine();
  const context: ToolCallContext = { cwd, permissionMode: 'accept_edits', sessionId: 'sandbox-test', callId: 'one', runId: 'run', processes };
  async function prepare(input: { command: string; hostAccessReason?: string; cwd?: string; yieldTimeMs?: number }) {
    const requirement = await provider.getPermissionRequirement('shell', input, context);
    const decision = await permissions.decide({ id: 'one', name: 'shell', input }, requirement, { snapshot: { permissionMode: 'accept_edits' } });
    return { requirement, decision, execute: (approvedByUser: boolean) => provider.callTool('shell', input, {
      ...context, authorization: { requirement, approvedByUser },
    }) as Promise<ManagedProcessPoll> };
  }
  try {
    const write = await prepare({ command: 'Set-Content -LiteralPath "inside file.txt" workspace; Get-Content "inside file.txt"', yieldTimeMs: 0 });
    assert.equal(write.decision.type, 'allow');
    const initial = await write.execute(false);
    const result = await processes.poll({ processId: initial.processId, waitMs: 15000, waitForExit: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(readFileSync(path.join(cwd, 'inside file.txt'), 'utf8').trim(), 'workspace');
    const outside = path.join(fixture, 'outside.txt');
    const powerShell = await prepare({ command: 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 9 }; "中文 ok" | Set-Content -LiteralPath inside-ps.txt' });
    const psWrite = await powerShell.execute(false);
    assert.equal(psWrite.exitCode, 0, JSON.stringify(psWrite.output));
    assert.equal(readFileSync(path.join(cwd, 'inside-ps.txt'), 'utf8').trim(), '中文 ok');
    const command = 'Set-Content -ErrorAction Stop outside.txt forbidden';
    const denied = await (await prepare({ command, cwd: fixture })).execute(false);
    assert.equal(denied.status, 'exited');
    assert.notEqual(denied.exitCode, 0);
    assert.equal(existsSync(outside), false);
    const host = await prepare({ command, cwd: fixture, hostAccessReason: 'Write the sibling fixture file.' });
    assert.equal(host.decision.type, 'ask');
    await assert.rejects(host.execute(false), /requires approval/);
    await assert.rejects(provider.callTool('shell', { command: 'echo changed', hostAccessReason: 'Different operation' }, {
      ...context, authorization: { requirement: host.requirement, approvedByUser: true },
    }), /does not have authorization/);
    assert.equal((await host.execute(true)).exitCode, 0);
    assert.equal(existsSync(outside), true);
    assert.equal((await prepare({ command: 'echo next', hostAccessReason: 'Another call' })).decision.type, 'ask');
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'sandbox-probe', version: '1.0.0', scripts: { build: 'node build.cjs', test: 'node test.cjs' },
    }));
    writeFileSync(path.join(cwd, 'build.cjs'), "require('node:fs').writeFileSync('built.txt','ok')");
    writeFileSync(path.join(cwd, 'test.cjs'), "require('node:assert/strict').equal(require('node:fs').readFileSync('built.txt','utf8'),'ok')");
    for (const cmd of ['npm.cmd install --offline --ignore-scripts --no-audit --no-fund --cache "$env:TEMP\\npm"', 'npm.cmd run build', 'npm.cmd test']) {
      const invocation = await prepare({ command: cmd, yieldTimeMs: 30000 });
      const outcome = await invocation.execute(false);
      assert.equal(outcome.exitCode, 0, JSON.stringify(outcome.output));
    }
    const background = await prepare({ command: 'node -e "console.log(process.env.TEMP);setInterval(()=>{},1000)"', yieldTimeMs: 0 });
    const started = await background.execute(false);
    const ready = await processes.poll({ processId: started.processId, waitMs: 15000 });
    assert.equal(ready.status, 'running', JSON.stringify(ready.output));
    const privateTemp = ready.output.map(chunk => chunk.text).join('').trim();
    assert.match(path.basename(privateTemp), /^actl-shell-/);
    await processes.stop({ processId: started.processId });
    assert.equal(existsSync(privateTemp), false);
    delete process.env.ACTL_SHELL_RUNNER;
    const unavailable = await prepare({ command: 'echo failed-open>unexpected.txt' });
    await assert.rejects(unavailable.execute(false), /sandbox unavailable/);
    assert.equal(existsSync(path.join(cwd, 'unexpected.txt')), false);
  } finally {
    await supervisor.dispose();
    if (previousRunner === undefined) delete process.env.ACTL_SHELL_RUNNER;
    else process.env.ACTL_SHELL_RUNNER = previousRunner;
    rmSync(fixture, { recursive: true, force: true });
  }
});
