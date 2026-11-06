import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const verificationRoot = path.join(root, 'artifacts', 'agent', packaged ? 'packaged' : 'source', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(verificationRoot, { recursive: true });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const executable = packaged ? path.join(root, 'dist/win-unpacked/Actl.exe') : createRequire(import.meta.url)('electron');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function verifyForcedExit() {
  const start = performance.now();
  const probeRoot = path.join(verificationRoot, 'forced-exit-probe');
  await mkdir(probeRoot, { recursive: true });
  const owner = spawn(executable, [...(packaged ? [] : [root]), '--verify-agent-exit-probe', `--verification-root=${probeRoot}`], {
    cwd: root, env: environment, windowsHide: true, stdio: 'ignore',
  });
  let spawnError; owner.once('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => owner.once('exit', resolve));
  let fixturePid;
  try {
    const readyDeadline = Date.now() + 20_000;
    while (Date.now() < readyDeadline) {
      if (spawnError) throw spawnError;
      const ready = await readFile(path.join(probeRoot, 'forced-exit-ready.json'), 'utf8').then(JSON.parse, () => undefined);
      if (ready) { fixturePid = ready.pid; break; }
      if (owner.exitCode !== null) throw new Error(`Probe owner exited early (${owner.exitCode}).`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!fixturePid || !alive(fixturePid)) throw new Error('Detached process was not running before main process termination.');
    process.kill(owner.pid, 'SIGKILL');
    await exited;
    const cleanupDeadline = Date.now() + 5_000;
    while (alive(fixturePid) && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (alive(fixturePid)) throw new Error('Detached descendant survived forced main process termination.');
    return { name: 'Forced main process exit removes detached Agent descendants', passed: true, durationMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { name: 'Forced main process exit removes detached Agent descendants', passed: false, durationMs: Math.round(performance.now() - start), error: error.message };
  } finally {
    if (owner.pid && alive(owner.pid)) { try { process.kill(owner.pid, 'SIGKILL'); } catch {} }
    if (fixturePid && alive(fixturePid)) { try { process.kill(fixturePid, 'SIGKILL'); } catch {} }
  }
}
const child = spawn(executable, [...(packaged ? [] : [root]), '--verify-agent', `--verification-root=${verificationRoot}`], {
  cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stdout.resume(); child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
const deadline = setTimeout(() => {
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.on('error', () => child.kill());
}, 90_000);
let code;
try { code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); }
finally { clearTimeout(deadline); }
const reportPath = path.join(verificationRoot, 'agent-report.json');
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (code === 0 && report.passed) {
    const forcedExit = await verifyForcedExit();
    report.checks.push(forcedExit); report.passed &&= forcedExit.passed;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Agent integration: Electron ${report.versions.electron} / Node ${report.versions.node} (${report.packaged ? 'packaged' : 'source'})`);
  for (const check of report.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name} (${check.durationMs} ms)${check.error ? `: ${check.error}` : ''}`);
  console.log(`Report: ${reportPath}`);
  process.exitCode = code === 0 && report.passed && report.packaged === packaged ? 0 : 1;
} catch {
  const error = await readFile(path.join(verificationRoot, 'error.txt'), 'utf8').catch(() => stderr);
  console.error(`Agent verification failed (exit ${code}): ${error}`); process.exitCode = 1;
}
