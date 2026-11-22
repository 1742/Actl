import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunPermissionEngine, type PermissionMode } from '../../../src/agent-core/permissions/run-policy.js';
import { ProcessSupervisor } from '../../../src/agent-core/runtime/process/process-supervisor.js';
import { ShellToolProvider } from '../../../src/agent-core/tools/builtin/shell.js';
import type { ToolCallContext } from '../../../src/agent-core/tools/registry.js';
import type { ManagedProcessPoll } from '../../../src/agent-core/runtime/process/process-types.js';

test('shell sandbox modes confine descendants and a host approval applies only to its command', { skip: process.platform !== 'win32' }, async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'actl-shell-test-'));
  const cwd = path.join(fixture, 'project with spaces');
  mkdirSync(cwd);
  const previousRunner = process.env.ACTL_SHELL_RUNNER;
  process.env.ACTL_SHELL_RUNNER ??= path.resolve('out/main/windows-shell-runner.cjs');
  const supervisor = new ProcessSupervisor();
  const processes = supervisor.forSession('sandbox-test');
  const provider = new ShellToolProvider();
  const permissions = new RunPermissionEngine();
  const context = { cwd, permissionMode: 'accept_edits', sessionId: 'sandbox-test', callId: 'one', runId: 'run', processes } as const;
  async function prepare(
    input: { command: string; hostAccessReason?: string; cwd?: string; yieldTimeMs?: number },
    current: ToolCallContext & { permissionMode: PermissionMode } = context,
  ) {
    const requirement = await provider.getPermissionRequirement('shell', input, current);
    const decision = await permissions.decide({ id: 'one', name: 'shell', input }, requirement, { snapshot: { permissionMode: current.permissionMode } });
    return { requirement, decision, execute: (approvedByUser: boolean) => provider.callTool('shell', input, {
      ...current, authorization: { requirement, approvedByUser },
    }) as Promise<ManagedProcessPoll> };
  }
  try {
    const write = await prepare({ command: 'Set-Content -LiteralPath "inside file.txt" workspace; Get-Content "inside file.txt"', yieldTimeMs: 0 });
    assert.equal(write.decision.type, 'allow');
    const initial = await write.execute(false);
    const result = await processes.poll({ processId: initial.processId, waitMs: 15000, waitForExit: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.output));
    assert.equal(readFileSync(path.join(cwd, 'inside file.txt'), 'utf8').trim(), 'workspace');

    const plan = { ...context, permissionMode: 'plan' } as const;
    const readCommand = { command: 'Get-Content -LiteralPath "inside file.txt"' };
    const read = await prepare(readCommand, plan);
    assert.equal(read.requirement.capability, 'process.spawn.readonly');
    assert.equal(read.decision.type, 'allow');
    await assert.rejects(prepare({ ...readCommand, hostAccessReason: 'Request host access' }, plan), /requires the Windows read-only shell sandbox/);
    const inspected = await read.execute(false);
    assert.equal(inspected.exitCode, 0, JSON.stringify(inspected.output));
    assert.equal(inspected.output.map(chunk => chunk.text).join('').trim(), 'workspace');
    const localized = await (await prepare({
      command: 'try { Get-Item -LiteralPath "中文缺失路径.txt" -ErrorAction Stop } catch { $_.Exception.Message; $_.FullyQualifiedErrorId }; Write-Error "中文错误 😀" -ErrorAction Stop',
    }, { ...plan, isSubagent: true })).execute(false);
    assert.equal(localized.status, 'exited');
    assert.notEqual(localized.exitCode, 0);
    const localizedStdout = localized.output.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('');
    const localizedStderr = localized.output.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.text).join('');
    assert.match(localizedStdout, /中文缺失路径\.txt/);
    assert.match(localizedStdout, /PathNotFound/);
    assert.match(localizedStderr, /中文错误 😀/);
    for (const command of [
      'Set-Content -ErrorAction Stop -LiteralPath "inside file.txt" forbidden',
      'node -e "require(\'node:fs\').writeFileSync(\'forbidden.txt\', \'forbidden\')"',
    ]) {
      const attemptedWrite = await (await prepare({ command }, plan)).execute(false);
      assert.equal(attemptedWrite.status, 'exited');
      assert.notEqual(attemptedWrite.exitCode, 0);
    }
    assert.equal(readFileSync(path.join(cwd, 'inside file.txt'), 'utf8').trim(), 'workspace');
    assert.equal(existsSync(path.join(cwd, 'forbidden.txt')), false);

    const backgroundRead = await (await prepare({ command: 'Get-Content "inside file.txt"; Start-Sleep -Seconds 60', yieldTimeMs: 0 }, plan)).execute(false);
    const processInput = { processId: backgroundRead.processId };
    const peer = { ...plan, sessionId: 'peer', processes: supervisor.forSession('peer') };
    await assert.rejects(provider.getPermissionRequirement('shell_stop', processInput, peer), /process_not_found/);
    const workspaceProcess = { processId: initial.processId };
    const workspaceStop = await provider.getPermissionRequirement('shell_stop', workspaceProcess, plan);
    assert.equal((await permissions.decide({ id: 'workspace-stop', name: 'shell_stop', input: workspaceProcess },
      workspaceStop, { snapshot: { permissionMode: 'plan' } })).type, 'deny');
    for (const name of ['shell_poll', 'shell_stop']) {
      const input = name === 'shell_poll' ? { ...processInput, waitMs: 15000 } : processInput;
      const requirement = await provider.getPermissionRequirement(name, input, plan);
      const decision = await permissions.decide({ id: name, name, input }, requirement, { snapshot: { permissionMode: 'plan' } });
      assert.equal(decision.type, 'allow');
      const state = await provider.callTool(name, input, { ...plan, authorization: { requirement, approvedByUser: false } }) as ManagedProcessPoll;
      assert.equal(state.status, name === 'shell_poll' ? 'running' : 'stopped');
    }

    const build = { ...context, permissionMode: 'ask', isSubagent: true } as const;
    const buildWrite = await prepare({ command: 'Set-Content build.txt ok' }, build);
    assert.equal(buildWrite.decision.type, 'ask');
    const built = await buildWrite.execute(true);
    assert.equal(built.exitCode, 0, JSON.stringify(built.output));
    assert.equal(readFileSync(path.join(cwd, 'build.txt'), 'utf8').trim(), 'ok');
    await assert.rejects(prepare({ ...readCommand, hostAccessReason: 'Request host access' }, build), /cannot request host shell access/);

    const outside = path.join(fixture, 'outside.txt');
    const powerShell = await prepare({ command: 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 9 }; "中文 ok" | Set-Content -LiteralPath inside-ps.txt; Get-Content -LiteralPath inside-ps.txt' });
    const psWrite = await powerShell.execute(false);
    assert.equal(psWrite.exitCode, 0, JSON.stringify(psWrite.output));
    assert.equal(psWrite.output.map(chunk => chunk.text).join('').trim(), '中文 ok');
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
    await assert.rejects((await prepare(readCommand, plan)).execute(false), /sandbox unavailable/);
    assert.equal(existsSync(path.join(cwd, 'unexpected.txt')), false);
  } finally {
    await supervisor.dispose();
    if (previousRunner === undefined) delete process.env.ACTL_SHELL_RUNNER;
    else process.env.ACTL_SHELL_RUNNER = previousRunner;
    rmSync(fixture, { recursive: true, force: true });
  }
});
