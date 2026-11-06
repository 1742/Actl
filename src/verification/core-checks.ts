import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_SCHEMA_SQL, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from '../agent-core/repositories/sqlite/schema';
import { runSqliteMigrations } from '../agent-core/repositories/sqlite/migrations';
import { createFileLogger } from '../agent-core/observability/logger';
import { runWithRequestContext } from '../agent-core/observability/request-context';
import { ProcessSupervisor } from '../agent-core/runtime/process/process-supervisor';
import { SecretProtector } from '../agent-core/security/secret-protector';
import { detectShellOutputEncoding, getShellRuntime } from '../agent-core/tools/builtin/shell';
import type { VerificationCheck } from './types';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (accept(value)) return value;
    await pause(50);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the expected result.');
}

export async function runCoreChecks(dataDirectory: string, fixturePath: string): Promise<VerificationCheck[]> {
  const options = { dataDirectory, fixturePath };
  const startedAt = new Date().toISOString();
  await mkdir(dataDirectory, { recursive: true });
  const checks: VerificationCheck[] = [];
  const check = async (name: string, run: () => Promise<string>) => {
    const start = performance.now();
    try { checks.push({ name, passed: true, details: await run(), durationMs: Math.round(performance.now() - start) }); }
    catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - start) }); }
  };
  await check('SQLite schema、事务与重开', async () => {
    const databasePath = path.join(options.dataDirectory, 'database', 'workspace.db');
    await mkdir(path.dirname(databasePath), { recursive: true });
    let database = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      database.exec(INITIAL_SCHEMA_SQL);
      database.prepare('INSERT INTO schema_metadata(id, generation, version, created_at) VALUES (1, ?, ?, ?)')
        .run(SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, startedAt);
      database.prepare('INSERT INTO projects(id, owner_id, cwd, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('project_probe', 'developer:local', options.dataDirectory, '中文验证项目', startedAt, startedAt);
      database.prepare('INSERT INTO sessions(id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('session_probe', 'developer:local', 'project_probe', 'Electron 验证', startedAt, startedAt);
      database.exec("BEGIN IMMEDIATE; UPDATE projects SET name = 'rollback' WHERE id = 'project_probe'; ROLLBACK;");
      assert.equal(database.prepare("SELECT name FROM projects WHERE id = 'project_probe'").get()?.name, '中文验证项目');
      assert.throws(() => database.prepare('INSERT INTO sessions(id, owner_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('invalid', 'developer:local', 'missing', startedAt, startedAt));
      assert.equal(database.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
      database.close();
      database = new DatabaseSync(databasePath, { timeout: 5_000 });
      runSqliteMigrations(database, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error('Schema rejected.'));
      assert.equal(database.prepare("SELECT title FROM sessions WHERE id = 'session_probe'").get()?.title, 'Electron 验证');
      return `node:sqlite 可用；schema v${SQLITE_SCHEMA_VERSION} 建库、WAL、外键、事务回滚及关闭后重开通过。`;
    } finally {
      database.close();
    }
  });

  await check('文件与凭据', async () => {
    const content = Buffer.from('Actl 中文附件\nElectron verification\n', 'utf8');
    const blobPath = path.join(options.dataDirectory, '附件 空格', 'probe.txt');
    await mkdir(path.dirname(blobPath), { recursive: true });
    await writeFile(blobPath, content, { flag: 'wx' });
    assert.equal(createHash('sha256').update(await readFile(blobPath)).digest('hex'), createHash('sha256').update(content).digest('hex'));
    const keyPath = path.join(options.dataDirectory, 'secrets', 'probe-master-key.bin');
    const secrets = new SecretProtector(keyPath);
    await secrets.initialize();
    const plaintext = `synthetic-credential-${randomUUID()}`;
    const envelope = secrets.encrypt(plaintext);
    const reopened = new SecretProtector(keyPath);
    await reopened.initialize();
    assert.equal(reopened.decrypt(envelope), plaintext);
    const damaged = { ...envelope, authTag: Buffer.alloc(16) };
    assert.throws(() => reopened.decrypt(damaged));
    return '中文及空格路径读写、内容哈希、AES-256-GCM 主密钥重载和篡改检测通过；仅使用合成凭据。';
  });

  await check('结构化日志', async () => {
    const directory = path.join(options.dataDirectory, 'logs');
    const logger = await createFileLogger({ directory, level: 'info', retentionDays: 3, maxFileSizeBytes: 1024 * 1024 });
    runWithRequestContext({ requestId: 'core-probe', ownerId: 'developer:local' }, () => {
      logger.info({ event: 'core.probe', text: '中文日志', apiKey: 'synthetic-sensitive-value' });
    });
    await logger.close?.();
    const lines = await eventually(async () => {
      const files = await readdir(directory);
      return (await Promise.all(files.filter((file) => file.endsWith('.ndjson')).map((file) => readFile(path.join(directory, file), 'utf8')))).join('\n');
    }, (text) => text.includes('core.probe'));
    const entry = lines.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'core.probe');
    assert.equal(entry?.apiKey, '[REDACTED]');
    assert.equal(entry?.requestId, 'core-probe');
    assert.equal(entry?.text, '中文日志');
    return 'pino / pino-roll 可写入 NDJSON；请求上下文、中文和敏感字段脱敏通过。';
  });

  const childEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const shell = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  await check('Windows 命令进程', async () => {
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 2_000, forceKillDelayMs: 300 });
    try {
      const encoding = await detectShellOutputEncoding(getShellRuntime());
      const result = await supervisor.execute({
        command: 'echo Actl_中文_shell_probe',
        cwd: options.dataDirectory, shell, outputEncoding: encoding, timeoutMs: 5_000,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Actl_中文_shell_probe/);
      const owner = { type: 'session' as const, id: 'verification' };
      const started = await supervisor.start({
        command: `"${process.execPath}" "${options.fixturePath}" --process-probe`,
        cwd: options.dataDirectory, shell, outputEncoding: 'utf8', env: childEnvironment,
        owner, startupWaitMs: 500,
      });
      assert.equal(started.status, 'running');
      const output = await supervisor.poll({ owner, processId: started.processId, waitMs: 2_000 });
      const text = output.output.map((chunk) => chunk.text).join('');
      const pidMatch = /ACTL_PROCESS_PID=(\d+)/.exec(text);
      assert.ok(pidMatch, `Process fixture did not start: ${text}`);
      const childPid = Number(pidMatch[1]);
      const stopped = await supervisor.stop({ owner, processId: started.processId });
      assert.equal(stopped.status, 'stopped');
      await eventually(async () => isProcessAlive(childPid), (alive) => !alive);
      return `ProcessSupervisor 执行、中文输出（代码页 ${encoding}）、后台轮询、停止及命令子进程退出确认通过。`;
    } finally {
      await supervisor.dispose();
    }
  });

  return checks;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
