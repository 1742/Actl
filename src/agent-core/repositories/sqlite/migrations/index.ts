import type { DatabaseSync } from "node:sqlite";
export interface SqliteMigration {
  from: number;
  to: number;
  up(database: DatabaseSync): void;
}

// Registered, tested migrations. Each entry upgrades the database exactly one
// version; the runner below applies them in order until the current version.
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    from: 4,
    to: 5,
    up(database: DatabaseSync): void {
      // 1. 添加 permission_snapshot_json 列（兼容旧表）
      database.exec(`
        ALTER TABLE agent_runs ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '{"permissionMode":"ask"}'
      `);
    },
  },
  {
    from: 5,
    to: 6,
    up(database: DatabaseSync): void {
      // 修复 v5 数据库缺少 permission_snapshot_json 列的问题：该列在 v5
      // 的初始 schema 中已经存在，但早期的 v4->v5 迁移没有为旧库补上。
      // 先检查列是否存在，保证对已经包含该列的数据库幂等。
      const columns = database.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "permission_snapshot_json")) {
        database.exec(`
          ALTER TABLE agent_runs ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '{"permissionMode":"ask"}'
        `);
      }
    },
  },
  {
    from: 6,
    to: 7,
    up(database: DatabaseSync): void {
    },
  },
  {
    from: 7,
    to: 8,
    up(database: DatabaseSync): void {
      database.exec("ALTER TABLE agent_runs DROP COLUMN compressed_summary;");
      database.exec(`
        CREATE TABLE session_context_states(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL, summarized_run_count INTEGER NOT NULL CHECK(summarized_run_count >= 0), last_input_tokens INTEGER, updated_at TEXT NOT NULL) STRICT;
        CREATE TABLE model_invocation_usage(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, step INTEGER NOT NULL CHECK(step >= 0), input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(run_id, step)) STRICT;
      `);
    },
  },
  {
    from: 8,
    to: 9,
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE context_compressions(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, summarized_run_count INTEGER NOT NULL CHECK(summarized_run_count > 0), summary TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, summarized_run_count)) STRICT;
        INSERT INTO context_compressions(session_id, summarized_run_count, summary, created_at)
        SELECT session_id, summarized_run_count, summary, updated_at FROM session_context_states
        WHERE summary <> '' AND summarized_run_count > 0;
      `);
    },
  },
  {
    from: 9,
    to: 10,
    up(database: DatabaseSync): void {
      database.exec(`
        DROP TRIGGER IF EXISTS memory_chunks_ai;
        DROP TRIGGER IF EXISTS memory_chunks_ad;
        DROP INDEX IF EXISTS memory_chunks_session_idx;
        DROP TABLE IF EXISTS memory_chunks_fts;
        DROP TABLE IF EXISTS memory_chunks;
      `);
    },
  },
  {
    from: 10,
    to: 11,
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE web_search_settings(
          owner_id TEXT PRIMARY KEY, provider TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), base_url TEXT NOT NULL,
          ciphertext BLOB, nonce BLOB, auth_tag BLOB, key_version INTEGER,
          updated_at TEXT NOT NULL,
          CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
                (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL))
        ) STRICT;
      `);
    },
  },
  {
    from: 11,
    to: 12,
    up(database: DatabaseSync): void {
      database.exec("ALTER TABLE web_search_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto', 'native', 'brave'));");
    },
  },
  {
    from: 12,
    to: 13,
    up(database: DatabaseSync): void {
      const has = (name: string) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      if (has("agent_runs")) database.exec("DELETE FROM agent_runs;");
      if (has("preset_provider_credentials")) database.exec("DROP TABLE preset_provider_credentials;");
      if (has("provider_accounts")) database.exec("ALTER TABLE provider_accounts DROP COLUMN provider_type;");
    },
  },
  {
    from: 13,
    to: 14,
    up(database: DatabaseSync): void {
      database.exec(`
        DROP TABLE IF EXISTS web_search_settings;
        CREATE TABLE web_search_settings(
          owner_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('brave', 'tavily', 'serper')),
          mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto', 'native', 'external')),
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), base_url TEXT NOT NULL,
          ciphertext BLOB, nonce BLOB, auth_tag BLOB, key_version INTEGER,
          updated_at TEXT NOT NULL,
          CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
                (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL))
        ) STRICT;
      `);
    },
  },
  {
    from: 14,
    to: 15,
    up(database: DatabaseSync): void {
      database.exec(`
        DROP TABLE IF EXISTS web_search_settings;
        CREATE TABLE web_search_settings(
          owner_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('brave', 'tavily', 'serper', 'bocha')),
          mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto', 'native', 'external')),
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), base_url TEXT NOT NULL,
          ciphertext BLOB, nonce BLOB, auth_tag BLOB, key_version INTEGER,
          updated_at TEXT NOT NULL,
          CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
                (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL))
        ) STRICT;
      `);
    },
  },
  {
    from: 15,
    to: 16,
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE mcp_servers(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL, key_version INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT;
      `);
    },
  },
  {
    from: 16,
    to: 17,
    up(database: DatabaseSync): void {
      database.exec("DROP TABLE IF EXISTS mcp_import_state;");
    },
  },
  {
    from: 17,
    to: 18,
    up(database: DatabaseSync): void {
      database.exec(`
        CREATE TABLE prompt_settings(
          owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
          blocks_json TEXT NOT NULL CHECK(json_valid(blocks_json)), updated_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
];

export function runSqliteMigrations(
  database: DatabaseSync,
  generation: string,
  currentVersion: number,
  incompatible: () => Error,
): void {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'").get();
  if (!table) throw incompatible();
  const row = database.prepare("SELECT generation, version FROM schema_metadata WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row || row.generation !== generation || typeof row.version !== "number" || row.version > currentVersion) throw incompatible();

  let version = row.version;
  while (version < currentVersion) {
    const migration = SQLITE_MIGRATIONS.find((candidate) => candidate.from === version);
    if (!migration || migration.to <= migration.from) throw incompatible();
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.up(database);
      database.prepare("UPDATE schema_metadata SET version = ? WHERE id = 1").run(migration.to);
      database.exec("COMMIT");
      version = migration.to;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
