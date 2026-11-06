import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = process.argv.includes('--packaged');
const verificationRoot = path.join(root, 'artifacts', 'compatibility', packaged ? 'packaged' : 'source', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(verificationRoot, { recursive: true });
const executable = packaged ? path.join(root, 'dist', 'win-unpacked', 'Actl.exe') : createRequire(import.meta.url)('electron');
const args = [...(packaged ? [] : [root]), '--verify-runtime', `--verification-root=${verificationRoot}`];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let diagnostics = '';
child.stdout.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-12_000); });
child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-12_000); });
const deadline = setTimeout(() => {
  if (child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  }
}, 60_000);
let exitCode;
try {
  exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
} finally { clearTimeout(deadline); }
const reportPath = path.join(verificationRoot, 'latest.json');
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  console.log(`Electron ${report.versions.electron} / Node ${report.versions.node} (${report.packaged ? 'packaged' : 'source'})`);
  for (const check of report.checks) console.log(`${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.name} (${check.durationMs} ms): ${check.details}`);
  console.log(`${report.shutdown.acknowledged && report.shutdown.exitCode === 0 ? 'PASS' : 'FAIL'} utility shutdown: acknowledgement=${report.shutdown.acknowledged}, exit=${report.shutdown.exitCode}`);
  console.log(`Report: ${reportPath}`);
  process.exitCode = exitCode === 0 && report.passed && report.packaged === packaged ? 0 : 1;
} catch (error) {
  const startupError = await readFile(path.join(verificationRoot, 'error.txt'), 'utf8').catch(() => '');
  console.error(`Verification failed (exit ${exitCode}): ${startupError || diagnostics || error.message}`);
  console.error(`Artifacts: ${verificationRoot}`);
  process.exitCode = 1;
}
