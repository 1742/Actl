import type { DatabaseSync } from "node:sqlite";

export function migrateAgentCoordination(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
    ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
    ALTER TABLE sessions ADD COLUMN origin_run_id TEXT;
    ALTER TABLE sessions ADD COLUMN origin_call_id TEXT;
    UPDATE sessions SET root_session_id = id;
    CREATE INDEX sessions_root_idx ON sessions(root_session_id);
    CREATE UNIQUE INDEX sessions_delegation_idx ON sessions(origin_run_id, origin_call_id);
    CREATE TABLE agent_plans(root_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     revision INTEGER NOT NULL, items_json TEXT NOT NULL CHECK(json_valid(items_json))) STRICT;
    CREATE TABLE agent_messages(id TEXT PRIMARY KEY, from_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     to_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, source_run_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('message', 'result')), text TEXT NOT NULL,
     wake INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, dedupe_key TEXT NOT NULL UNIQUE) STRICT;
    CREATE INDEX agent_messages_inbox_idx ON agent_messages(to_session_id, consumed);
  `);
}
