import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import iconv from 'iconv-lite';
import type { CompatibilityCheck, CompatibilityReport, VerificationOptions } from '../shared/compatibility';
import { INITIAL_SCHEMA_SQL, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from './legacy/repositories/sqlite/schema';
import { runSqliteMigrations } from './legacy/repositories/sqlite/migrations';
import { createFileLogger } from './legacy/observability/logger';
import { runWithRequestContext } from './legacy/observability/request-context';
import { ProcessSupervisor } from './legacy/runtime/process/process-supervisor';
import { SecretProtector } from './legacy/security/secret-protector';

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

export async function runChecks(
  options: VerificationOptions,
  onCheck: (check: CompatibilityCheck) => void,
): Promise<Omit<CompatibilityReport, 'shutdown'>> {
  const startedAt = new Date().toISOString();
  await mkdir(options.dataDirectory, { recursive: true });
  const checks: CompatibilityCheck[] = [];
  const check = async (id: string, name: string, run: () => Promise<string>): Promise<void> => {
    const start = performance.now();
    let result: CompatibilityCheck;
    try {
      result = { id, name, status: 'passed', details: await run(), durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      result = { id, name, status: 'failed', details: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - start) };
    }
    checks.push(result);
    onCheck(result);
  };

  await check('utility', '内部运行时', async () => {
    assert.ok(process.parentPort, 'Must execute inside an Electron utility process.');
    assert.notEqual(process.pid, options.mainPid);
    assert.equal(process.platform, 'win32');
    assert.equal(Number(process.versions.node.split('.')[0]), 24);
    return `独立 PID ${process.pid}；Electron ${process.versions.electron} / Node ${process.versions.node}；无业务 HTTP 服务。`;
  });

  await check('sqlite', 'SQLite 与旧版数据库结构', async () => {
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
      runSqliteMigrations(database, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error('Legacy schema rejected.'));
      assert.equal(database.prepare("SELECT title FROM sessions WHERE id = 'session_probe'").get()?.title, 'Electron 验证');
      return `node:sqlite 可用；旧 schema v${SQLITE_SCHEMA_VERSION} 建库、WAL、外键、事务回滚及关闭后重开通过。`;
    } finally {
      database.close();
    }
  });

  await check('files-secrets', '文件与凭据', async () => {
    const content = Buffer.from('Actl 中文附件\nElectron compatibility\n', 'utf8');
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
    return '中文及空格路径读写、内容哈希、旧 AES-256-GCM 主密钥重载和篡改检测通过；仅使用合成凭据。';
  });

  await check('logging', '结构化日志', async () => {
    const directory = path.join(options.dataDirectory, 'logs');
    const logger = await createFileLogger({ directory, level: 'info', retentionDays: 3, maxFileSizeBytes: 1024 * 1024 });
    runWithRequestContext({ requestId: 'compatibility-probe', ownerId: 'developer:local' }, () => {
      logger.info({ event: 'compatibility.probe', text: '中文日志', apiKey: 'synthetic-sensitive-value' });
    });
    const lines = await eventually(async () => {
      const files = await readdir(directory);
      return (await Promise.all(files.filter((file) => file.endsWith('.ndjson')).map((file) => readFile(path.join(directory, file), 'utf8')))).join('\n');
    }, (text) => text.includes('compatibility.probe'));
    const entry = lines.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'compatibility.probe');
    assert.equal(entry?.apiKey, '[REDACTED]');
    assert.equal(entry?.requestId, 'compatibility-probe');
    assert.equal(entry?.text, '中文日志');
    return '旧 pino / pino-roll 实现可写入 NDJSON；请求上下文、中文和敏感字段脱敏通过。';
  });

  const childEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const shell = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
  await check('shell', 'Windows 命令进程', async () => {
    const supervisor = new ProcessSupervisor({ terminationGraceMs: 2_000, forceKillDelayMs: 300 });
    try {
      // Match the old ShellToolProvider: probe the active Windows code page
      // instead of assuming cmd emits UTF-8 or changing the user's code page.
      const probe = await supervisor.execute({
        command: 'chcp', cwd: options.dataDirectory, shell, outputEncoding: 'ascii', timeoutMs: 5_000,
      });
      assert.equal(probe.exitCode, 0);
      const codePage = Number(/(?:^|\D)(\d{3,5})(?:\D|$)/.exec(probe.stdout)?.[1]);
      assert.ok(Number.isInteger(codePage) && codePage > 0, 'Could not detect the Windows code page.');
      const aliases: Record<number, string> = { 65001: 'utf8', 932: 'shift_jis', 936: 'gbk', 949: 'cp949', 950: 'big5' };
      const encoding = aliases[codePage] ?? `cp${codePage}`;
      assert.ok(iconv.encodingExists(encoding), `Unsupported Windows encoding: ${encoding}`);
      const result = await supervisor.execute({
        command: 'echo Actl_中文_shell_probe',
        cwd: options.dataDirectory, shell, outputEncoding: encoding, timeoutMs: 5_000,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Actl_中文_shell_probe/);
      const owner = { type: 'session' as const, id: 'compatibility' };
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
      return `旧 ProcessSupervisor 执行、中文输出（代码页 ${codePage}）、后台轮询、停止及命令子进程退出确认通过。`;
    } finally {
      await supervisor.dispose();
    }
  });

  await check('mcp', 'MCP stdio', async () => {
    const client = new Client({ name: 'actl-compatibility', version: '0.1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [options.fixturePath],
      cwd: options.dataDirectory,
      env: Object.fromEntries(Object.entries(childEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      stderr: 'pipe',
    });
    let serverPid: number | undefined;
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk).slice(0, 2_000); });
    try {
      await client.connect(transport, { timeout: 8_000 });
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'add'));
      const result = await client.callTool({ name: 'add', arguments: { a: 19, b: 23 } });
      assert.notEqual(result.isError, true);
      const part = result.content?.find((content) => content.type === 'text');
      assert.ok(part && part.type === 'text');
      const value = JSON.parse(part.text) as { sum: number; pid: number; node: string };
      assert.equal(value.sum, 42);
      assert.equal(value.node, process.versions.node);
      serverPid = value.pid;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `; MCP stderr: ${stderr}` : ''}`);
    } finally {
      await client.close();
      await transport.close();
    }
    assert.ok(serverPid);
    await eventually(async () => isProcessAlive(serverPid), (alive) => !alive);
    return '旧版 MCP SDK 2.0.0 完成初始化、工具发现、19 + 23 = 42 调用及退出确认；子进程使用随应用分发的 Electron，无需外部 Node。';
  });

  return {
    passed: checks.every((result) => result.status === 'passed'),
    startedAt, completedAt: new Date().toISOString(),
    dataDirectory: options.dataDirectory, packaged: options.packaged,
    versions: {
      electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome,
      platform: process.platform, arch: process.arch,
    },
    utilityPid: process.pid, mainPid: options.mainPid, checks,
  };
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
