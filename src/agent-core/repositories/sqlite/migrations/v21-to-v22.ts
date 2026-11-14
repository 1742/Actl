import type { DatabaseSync } from 'node:sqlite';

export function migrateAgentMessageAuthor(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE agent_messages ADD COLUMN author TEXT CHECK(author IN ('user', 'model'));
    ALTER TABLE agent_messages ADD COLUMN model TEXT;
  `);
}
