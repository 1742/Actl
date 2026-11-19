import type { DatabaseSync } from 'node:sqlite';

const WAIT_TABLE = `
CREATE TABLE agent_waits (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  condition_json TEXT NOT NULL CHECK(json_valid(condition_json)), deadline INTEGER NOT NULL,
  event_cursor INTEGER NOT NULL, interrupted_call_id TEXT
) STRICT;
`;

const RUN_FINISHED_TRIGGER = `
CREATE TRIGGER agent_run_finished AFTER UPDATE OF status ON agent_runs
WHEN OLD.status IN ('in_progress','waiting_permission') AND NEW.status NOT IN ('in_progress','waiting_permission')
BEGIN
  DELETE FROM agent_waits WHERE run_id = NEW.id;
  INSERT INTO agent_coordination_events(root_id, kind, subject_id)
  SELECT COALESCE(root_session_id, id), 'run_finished', NEW.id FROM sessions WHERE id = NEW.session_id
  ON CONFLICT DO NOTHING;
END;
`;

const RUN_STATE_CHANGED_TRIGGER = `
CREATE TRIGGER agent_run_state_changed AFTER UPDATE OF status ON agent_runs
WHEN NEW.status <> OLD.status
BEGIN
  INSERT INTO agent_coordination_events(root_id, kind, subject_id, state)
  SELECT COALESCE(root_session_id, id), 'agent_changed', id,
    CASE
      WHEN EXISTS (SELECT 1 FROM agent_stopped_sessions WHERE session_id = NEW.session_id) THEN 'stopped'
      WHEN NEW.status = 'in_progress' THEN 'running'
      WHEN NEW.status = 'waiting_permission' THEN 'waiting_permission'
      ELSE 'idle'
    END
  FROM sessions WHERE id = NEW.session_id;
END;
`;

export const COORDINATION_SCHEMA = `
CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, root_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL, acceptance_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','assigned','running','review_required','completed','failed','cancelled')),
  auto_assign INTEGER NOT NULL CHECK(auto_assign IN (0,1)), creation_key TEXT NOT NULL UNIQUE,
  UNIQUE(root_id, number)
) STRICT;
CREATE TABLE agent_task_dependencies (
  task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  CHECK(task_id <> dependency_id), PRIMARY KEY(task_id, dependency_id)
) STRICT;
CREATE TABLE agent_task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'active' CHECK(outcome IN ('active','submitted','accepted','rejected','failed','cancelled')),
  reason TEXT
) STRICT;
CREATE UNIQUE INDEX agent_attempt_active_task_idx ON agent_task_attempts(task_id) WHERE outcome IN ('active','submitted');
CREATE UNIQUE INDEX agent_attempt_active_owner_idx ON agent_task_attempts(owner_id) WHERE outcome = 'active';
CREATE INDEX agent_attempt_history_idx ON agent_task_attempts(task_id, started_at);
CREATE TABLE agent_attempt_runs (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES agent_task_attempts(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE agent_results (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES agent_task_attempts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE agent_task_decisions (
  operation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('accept','reject','cancel','retry'))
) STRICT;
CREATE TABLE agent_mail (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, root_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, body TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('information','question','progress','urgent')),
  author TEXT NOT NULL CHECK(author IN ('user','model')), created_at INTEGER NOT NULL, read_at INTEGER,
  thread_id TEXT NOT NULL, reply_to TEXT REFERENCES agent_mail(id) ON DELETE SET NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)), operation_key TEXT NOT NULL UNIQUE,
  UNIQUE(root_id, number)
) STRICT;
CREATE INDEX agent_mail_delivery_idx ON agent_mail(recipient_id, delivered, number);
CREATE INDEX agent_mail_reply_idx ON agent_mail(reply_to);
${WAIT_TABLE}
CREATE TABLE agent_stopped_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE agent_coordination_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('task_changed','run_finished','review_requested','mail_received','agent_changed')),
  subject_id TEXT NOT NULL, recipient_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT, created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  dispatched INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX agent_events_outbox_idx ON agent_coordination_events(id) WHERE dispatched = 0;
CREATE UNIQUE INDEX agent_run_finished_event_idx ON agent_coordination_events(subject_id) WHERE kind = 'run_finished';
CREATE INDEX agent_events_state_idx ON agent_coordination_events(root_id, subject_id, kind, id) WHERE state IS NOT NULL;
CREATE INDEX agent_events_inbox_idx ON agent_coordination_events(recipient_id, id) WHERE delivered = 0;

CREATE UNIQUE INDEX agent_single_active_run_idx ON agent_runs(session_id)
  WHERE status IN ('in_progress', 'waiting_permission');

${RUN_FINISHED_TRIGGER}
CREATE TRIGGER agent_session_removing BEFORE DELETE ON sessions
WHEN OLD.parent_session_id IS NOT NULL
BEGIN
  INSERT INTO agent_coordination_events(root_id, kind, subject_id, state)
  SELECT task.root_id, 'task_changed', task.id, 'failed' FROM agent_tasks task
  JOIN sessions root ON root.id = task.root_id
  JOIN agent_task_attempts a ON a.task_id = task.id
  WHERE a.owner_id = OLD.id AND a.outcome IN ('active', 'submitted');

  UPDATE agent_tasks SET status = 'failed' WHERE id IN (
    SELECT task_id FROM agent_task_attempts WHERE owner_id = OLD.id AND outcome IN ('active', 'submitted')
  );
END;

CREATE TRIGGER agent_run_started AFTER INSERT ON agent_runs
WHEN NEW.status = 'in_progress'
BEGIN
  INSERT INTO agent_coordination_events(root_id, kind, subject_id, state)
  SELECT COALESCE(root_session_id, id), 'agent_changed', id, 'running' FROM sessions WHERE id = NEW.session_id;
END;

${RUN_STATE_CHANGED_TRIGGER}
`;

export const RETIRED_AGENT_SCHEMA = `
CREATE TABLE agent_retired_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
`;

export function replaceAgentCoordination(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE agent_task_assignments;
    DROP TABLE agent_tasks;
    DROP TABLE agent_messages;
    ALTER TABLE agent_runs ADD COLUMN final_output TEXT;
    UPDATE run_messages SET payload_json = json_set(payload_json, '$.source', json_object('kind', 'runtime'))
      WHERE json_extract(payload_json, '$.source.kind') = 'agent';
    UPDATE timeline_items SET payload_json = json_set(payload_json, '$.source', json_object('kind', 'runtime'))
      WHERE item_type = 'message' AND json_extract(payload_json, '$.source.kind') = 'agent';
    UPDATE run_messages SET payload_json = json_set(payload_json, '$.source', json_object('kind', 'user'))
      WHERE json_extract(payload_json, '$.source.kind') = 'user' AND json_type(payload_json, '$.source.assignmentId') IS NOT NULL;
    UPDATE timeline_items SET payload_json = json_set(payload_json, '$.source', json_object('kind', 'user'))
      WHERE item_type = 'message' AND json_extract(payload_json, '$.source.kind') = 'user'
        AND json_type(payload_json, '$.source.assignmentId') IS NOT NULL;
    ${COORDINATION_SCHEMA}
  `);
}
export function bindWaitsToActiveRuns(db: DatabaseSync): void {
  db.exec(`
    DROP TRIGGER agent_run_finished;
    DROP TRIGGER agent_run_state_changed;
    DROP TABLE agent_waits;
    ${WAIT_TABLE}

    DELETE FROM agent_coordination_events WHERE kind = 'wait_changed';

    -- Reconcile parked v26 runs after upgrading to the active-run protocol.
    UPDATE agent_coordination_events SET dispatched = 0
      WHERE kind = 'run_finished' AND subject_id IN (
        SELECT run.id FROM agent_runs run WHERE run.status = 'waiting'
          AND NOT EXISTS (SELECT 1 FROM agent_runs later WHERE later.session_id = run.session_id AND later.run_order > run.run_order)
      );
    INSERT OR IGNORE INTO agent_coordination_events(root_id, kind, subject_id)
      SELECT COALESCE(session.root_session_id, session.id), 'run_finished', run.id
      FROM agent_runs run JOIN sessions session ON session.id = run.session_id WHERE run.status = 'waiting'
        AND NOT EXISTS (SELECT 1 FROM agent_runs later WHERE later.session_id = run.session_id AND later.run_order > run.run_order);
    UPDATE agent_runs SET status = 'incomplete', error_code = 'runtime_interrupted',
      error_message = 'The previous runtime suspended this run before a workspace upgrade.'
      WHERE status = 'waiting';

    ${RUN_FINISHED_TRIGGER}
    ${RUN_STATE_CHANGED_TRIGGER}
  `);
}
