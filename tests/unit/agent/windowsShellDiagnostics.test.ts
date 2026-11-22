import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolvePowerShell } from '../../../src/agent-core/tools/builtin/shell.js';

test('pwsh lookup skips inaccessible candidates and preserves unexpected errors', t => {
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'actl-pwsh-lookup-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const blocked = path.join(fixture, 'WindowsApps', 'pwsh.exe');
  const installed = path.join(fixture, 'PowerShell', '7', 'pwsh.exe');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '');
  const originalStat = fs.statSync;
  let code = 'EACCES';
  t.mock.method(fs, 'statSync', (file: string, options: { throwIfNoEntry: false }) => {
    if (file === blocked) throw Object.assign(new Error(code), { code });
    return originalStat(file, options);
  });
  const environment = { PATH: path.dirname(blocked), ProgramFiles: fixture };
  for (code of ['EACCES', 'EPERM']) assert.equal(resolvePowerShell(environment), installed);
  fs.unlinkSync(installed);
  assert.throws(() => resolvePowerShell(environment), (error: Error) =>
    error.message.includes(blocked) && error.message.includes('EPERM') && error.message.includes(installed));
  code = 'EIO';
  assert.throws(() => resolvePowerShell(environment), { code: 'EIO' });
});

test('runner identifies the directory when Windows refuses to set its integrity label', { skip: process.platform !== 'win32' }, t => {
  const fixture = fs.mkdtempSync(path.join(tmpdir(), 'actl-acl-diagnostic-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const system32 = path.join(process.env.SystemRoot!, 'System32');
  const identity = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = identity.match(/S-1-[\d-]+/)?.[0];
  assert.ok(sid, 'expected a Windows user SID');
  const shell = resolvePowerShell();
  for (const role of ['工作区', '私有临时目录']) {
    const workspace = fs.mkdtempSync(path.join(fixture, 'project-'));
    const temp = fs.mkdtempSync(path.join(fixture, 'temp-'));
    const target = role === '工作区' ? workspace : temp;
    execFileSync(path.join(system32, 'icacls.exe'), [target, '/deny', `*${sid}:(WO)`]);
    const result = spawnSync(process.execPath, [path.resolve('out/main/windows-shell-runner.cjs'),
      'workspace-write', workspace, shell, 'Set-Content ran.txt unexpected', workspace, temp], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 127, result.stderr);
    assert.ok(result.stderr.includes(`${role}「${target}」`), result.stderr);
    assert.match(result.stderr, /SetNamedSecurityInfoW failed \(Win32 5\)/);
    assert.equal(fs.existsSync(path.join(workspace, 'ran.txt')), false);
  }
});
