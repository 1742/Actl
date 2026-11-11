import type { DatabaseSync } from 'node:sqlite';

export const AGENT_MAIL_SQL = `
CREATE TABLE agent_mail(
  id TEXT PRIMARY KEY,
  from_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message', 'result')),
  subject TEXT NOT NULL, body TEXT NOT NULL, sent_at TEXT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0, 1)),
  dedupe_key TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX agent_mail_recipient_idx ON agent_mail(to_session_id, is_read);
`;

export function migrateAgentMail(database: DatabaseSync): void {
  database.exec(AGENT_MAIL_SQL);
  database.exec(`
    ALTER TABLE agent_messages ADD COLUMN author TEXT CHECK(author IN ('user', 'model'));
    ALTER TABLE agent_messages ADD COLUMN model TEXT;
    INSERT INTO agent_mail(id, from_session_id, to_session_id, source_run_id, kind, subject, body, is_read, dedupe_key)
      SELECT m.id, m.from_session_id, m.to_session_id, m.source_run_id, m.kind,
        CASE m.kind WHEN 'result' THEN 'Child run result' ELSE 'Agent message' END, m.text, m.consumed, m.dedupe_key
      FROM agent_messages m JOIN sessions s ON s.id = m.from_session_id
      WHERE s.parent_session_id = m.to_session_id ORDER BY m.rowid;
    UPDATE timeline_items SET payload_json = json_set(payload_json, '$.source',
      json_object('kind', 'mail', 'subject', (SELECT subject FROM agent_mail WHERE id = timeline_items.item_id)))
      WHERE item_type = 'message' AND EXISTS (
        SELECT 1 FROM agent_mail m JOIN agent_runs r ON r.session_id = m.to_session_id
        WHERE m.id = timeline_items.item_id AND r.id = timeline_items.run_id
      );
    DELETE FROM agent_messages WHERE id IN (SELECT id FROM agent_mail);
  `);
}
