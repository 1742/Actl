import type { DatabaseSync } from 'node:sqlite';
import { agentNameKey, availableAgentName, validAgentName } from '../../../runtime/multi-agents/agent-name.js';

export const AGENT_NAME_INDEX = `
CREATE UNIQUE INDEX sessions_child_name_idx ON sessions(root_session_id, agent_name_key)
  WHERE parent_session_id IS NOT NULL;
`;

export function migrateAgentNames(db: DatabaseSync): void {
  db.exec('ALTER TABLE sessions ADD COLUMN agent_name_key TEXT');
  const children = db.prepare(`SELECT id, root_session_id, title FROM sessions
    WHERE parent_session_id IS NOT NULL ORDER BY created_at, id`).all();
  const used = new Map<string, Set<string>>();
  const reserved = new Map<string, Set<string>>();
  const entries = children.map((child) => {
    const root = String(child.root_session_id);
    const title = typeof child.title === 'string' ? validAgentName(child.title) : undefined;
    const keys = reserved.get(root) ?? new Set<string>();
    if (title) keys.add(agentNameKey(title));
    reserved.set(root, keys);
    return { id: String(child.id), root, title };
  });

  const update = db.prepare('UPDATE sessions SET title = ?, agent_name_key = ? WHERE id = ?');
  for (const { id, root, title } of entries) {
    const usedKeys = used.get(root) ?? new Set<string>();
    const reservedKeys = reserved.get(root)!;
    const name = title && !usedKeys.has(agentNameKey(title)) ? title : availableAgentName(title, reservedKeys);
    const key = agentNameKey(name);
    usedKeys.add(key);
    reservedKeys.add(key);
    used.set(root, usedKeys);
    update.run(name, key, id);
  }
  db.exec(AGENT_NAME_INDEX);
}
