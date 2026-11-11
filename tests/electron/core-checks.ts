import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from '../../src/agent-core/repositories/sqlite/initial-schema';
import { openWorkspaceDatabase } from '../../src/agent-core/repositories/sqlite/database';
import { SqliteProjectRepository } from '../../src/agent-core/repositories/sqlite/project-repository';
import { SqliteSessionRepository } from '../../src/agent-core/repositories/sqlite/session-repository';
import { SqliteStoredFileRepository } from '../../src/agent-core/repositories/sqlite/stored-file-repository';
import { createFileLogger } from '../../src/agent-core/observability/logger';
import { runWithRequestContext } from '../../src/agent-core/observability/request-context';
import { ProcessSupervisor } from '../../src/agent-core/runtime/process/process-supervisor';
import { SecretProtector } from '../../src/agent-core/security/secret-protector';
import { detectShellOutputEncoding, getShellRuntime } from '../../src/agent-core/tools/builtin/shell';
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
    let database = await openWorkspaceDatabase(databasePath);
    try {
      const metadata = database.prepare("SELECT generation, version FROM schema_metadata WHERE id = 1").get();
      assert.equal(metadata?.generation, SQLITE_SCHEMA_GENERATION);
      assert.equal(metadata?.version, SQLITE_SCHEMA_VERSION);
      database.prepare('INSERT INTO projects(id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('project_probe', 'developer:local', '中文验证项目', startedAt, startedAt);
      database.prepare('INSERT INTO sessions(id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('session_probe', 'developer:local', 'project_probe', 'Electron 验证', startedAt, startedAt);
      database.exec("BEGIN IMMEDIATE; UPDATE projects SET name = 'rollback' WHERE id = 'project_probe'; ROLLBACK;");
      assert.equal(database.prepare("SELECT name FROM projects WHERE id = 'project_probe'").get()?.name, '中文验证项目');
      assert.throws(() => database.prepare('INSERT INTO sessions(id, owner_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('invalid', 'developer:local', 'missing', startedAt, startedAt));
      assert.equal(database.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
      database.close();
      database = await openWorkspaceDatabase(databasePath);
      assert.equal(database.prepare("SELECT title FROM sessions WHERE id = 'session_probe'").get()?.title, 'Electron 验证');
      return `node:sqlite 可用；schema v${SQLITE_SCHEMA_VERSION} 建库、WAL、外键、事务回滚及关闭后重开通过。`;
    } finally {
      if (database.isOpen) database.close();
    }
  });

  await check('SQLite v19 多工作区迁移、项目保存回滚与重开', async () => {
    const databasePath = path.join(options.dataDirectory, 'database', 'v19.db');
    const offline = path.join(options.dataDirectory, '旧工作区（离线）');
    const otherDirectory = path.join(options.dataDirectory, '其他工作区');
    const database = new DatabaseSync(databasePath);
    try {
      // The v19 tables used by the migration, frozen independently of the initial schema.
      database.exec(`
        CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL) STRICT;
        CREATE TABLE projects(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, cwd TEXT NOT NULL,
          name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX projects_owner_cwd_idx ON projects(owner_id, cwd);
        CREATE TABLE sessions(
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE agent_runs(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_order INTEGER NOT NULL, status TEXT NOT NULL, model_snapshot_json TEXT NOT NULL,
          permission_snapshot_json TEXT NOT NULL DEFAULT '{"permissionMode":"ask"}',
          pending_tool_batch_json TEXT, error_code TEXT, error_message TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
          next_sequence_number INTEGER NOT NULL, UNIQUE(session_id, run_order)
        ) STRICT;
        CREATE TABLE run_messages(
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, message_order INTEGER NOT NULL,
          message_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, message_order)
        ) STRICT;
        CREATE TABLE timeline_items(
          run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, item_order INTEGER NOT NULL,
          item_id TEXT NOT NULL, item_type TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, item_order)
        ) STRICT;
        CREATE TABLE file_changes(
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL, change_type TEXT NOT NULL, summary TEXT NOT NULL,
          diff TEXT, new_content TEXT, old_content TEXT, created_at TEXT NOT NULL,
          run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE
        ) STRICT;
      `);
      database.prepare('INSERT INTO schema_metadata VALUES (1, ?, 19, ?)').run('multi-user-multi-model', startedAt);
      const addProject = database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)');
      addProject.run('old', 'owner', offline, '项目名称', startedAt, startedAt);
      addProject.run('other', 'owner', otherDirectory, null, startedAt, startedAt);
      database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run('session', 'owner', 'old', '会话名称', startedAt, startedAt);
      database.prepare(`INSERT INTO agent_runs(id, session_id, run_order, status, model_snapshot_json,
        created_at, updated_at, completed_at, next_sequence_number) VALUES ('run', 'session', 0, 'completed', '{}', ?, ?, ?, 0)`)
        .run(startedAt, startedAt, startedAt);
      database.prepare("INSERT INTO run_messages VALUES ('run', 0, 'message', ?)").run(JSON.stringify({
        type: 'message', id: 'message', role: 'user', content: [{ type: 'workspace_file', path: 'same.txt' }],
      }));
      database.prepare(`INSERT INTO file_changes(id, session_id, run_id, file_path, change_type, summary, created_at)
        VALUES ('change', 'session', 'run', 'same.txt', 'modify', 'same.txt', ?)`)
        .run(startedAt);
    } finally {
      database.close();
    }

    let migrated = await openWorkspaceDatabase(databasePath);
    try {
      const repository = new SqliteProjectRepository(migrated);
      const projects = await repository.listProjects();
      const sessions = await new SqliteSessionRepository(migrated, new SqliteStoredFileRepository(migrated)).listSessions();
      const old = projects.find(({ id }) => id === 'old')!;
      const other = projects.find(({ id }) => id === 'other')!;
      assert.equal(old.name, '项目名称');
      assert.equal(old.cwd, offline);
      assert.deepEqual(old.workspaces, [{ id: old.primaryWorkspaceId, path: offline }]);
      assert.equal(sessions[0]?.projectId, old.id);
      await assert.rejects(repository.updateProject({
        ...old, name: 'must roll back', workspaces: [...old.workspaces, { id: 'duplicate', path: other.cwd }],
      }), /UNIQUE constraint failed/);
      migrated.close();
      migrated = await openWorkspaceDatabase(databasePath);
      const reopened = await new SqliteProjectRepository(migrated).listProjects();
      assert.deepEqual(reopened.find(({ id }) => id === old.id), old);
      const read = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const stored = read.prepare("SELECT payload_json FROM run_messages WHERE run_id = 'run'").get();
        assert.equal(JSON.parse(String(stored?.payload_json)).content[0].path, path.join(offline, 'same.txt').split(path.sep).join('/'));
        assert.equal(read.prepare("SELECT file_path FROM file_changes WHERE id = 'change'").get()?.file_path, path.join(offline, 'same.txt'));
        assert.deepEqual(read.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        read.close();
      }
    } finally {
      if (migrated.isOpen) migrated.close();
    }
    return '离线路径、原项目和会话、历史引用、文件变更及保存回滚通过。';
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
