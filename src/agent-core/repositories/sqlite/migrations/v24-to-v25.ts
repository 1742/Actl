import type { DatabaseSync } from 'node:sqlite';

export const AGENT_TASKS_SQL = `
  CREATE TABLE agent_tasks (
    id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    acceptance_criteria TEXT NOT NULL,
    blocked_by_json TEXT NOT NULL CHECK(json_valid(blocked_by_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    creation_key TEXT NOT NULL,
    owner_session_id TEXT,
    assignment_id TEXT,
    assignment_run_id TEXT,
    dispatch_message_id TEXT,
    result_run_id TEXT,
    UNIQUE(root_session_id, creation_key)
  ) STRICT;
  CREATE INDEX agent_tasks_root_idx ON agent_tasks(root_session_id);
  CREATE UNIQUE INDEX agent_tasks_active_owner_idx ON agent_tasks(root_session_id, owner_session_id)
    WHERE status = 'in_progress';
  CREATE TABLE agent_task_assignments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL UNIQUE,
    owner_session_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    message_id TEXT
  ) STRICT;
  CREATE INDEX agent_messages_assignment_idx ON agent_messages(assignment_id) WHERE assignment_id IS NOT NULL;
`;

export function migrateAgentTasks(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE sessions ADD COLUMN agent_profile_json TEXT CHECK(agent_profile_json IS NULL OR json_valid(agent_profile_json));
    ALTER TABLE agent_messages ADD COLUMN task_id TEXT;
    ALTER TABLE agent_messages ADD COLUMN assignment_id TEXT;
    UPDATE agent_messages SET consumed = 1, wake = 0 WHERE consumed = 0 AND EXISTS (
      SELECT 1 FROM sessions child WHERE child.id = agent_messages.to_session_id AND child.parent_session_id IS NOT NULL
    );
  `);
  database.exec(AGENT_TASKS_SQL);
}
