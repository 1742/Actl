import type { DatabaseSync } from 'node:sqlite';

export function migrateAgentMessageAttribution(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE agent_messages ADD COLUMN relationship TEXT CHECK(relationship IN ('parent', 'child'));
    ALTER TABLE agent_messages ADD COLUMN purpose TEXT CHECK(purpose IN ('task', 'message', 'progress', 'clarification'));
    ALTER TABLE agent_messages ADD COLUMN reply_to TEXT;
    UPDATE agent_messages SET relationship = 'parent', purpose = 'message'
      WHERE author = 'model' AND EXISTS (
        SELECT 1 FROM sessions s WHERE s.id = agent_messages.to_session_id AND s.parent_session_id = agent_messages.from_session_id
      );
  `);
}
