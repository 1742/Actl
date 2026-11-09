import type { DatabaseSync } from 'node:sqlite';
import type { AgentInboxMessage, AgentPlan, PlanItem } from '../../../shared/agent/coordination.js';

/** Durable coordination state. Model-visible delivery is acknowledged after transcript persistence. */
export class AgentCoordinationStore {
  constructor(private readonly database: () => DatabaseSync) {}

  plan(rootId: string): AgentPlan {
    const row = this.database().prepare('SELECT revision, items_json FROM agent_plans WHERE root_session_id = ?').get(rootId);
    return row ? { revision: Number(row.revision), items: JSON.parse(String(row.items_json)) as PlanItem[] } : { revision: 0, items: [] };
  }

  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan {
    const db = this.database();
    const result = revision === 0
      ? db.prepare('INSERT INTO agent_plans(root_session_id, revision, items_json) VALUES (?, 1, ?) ON CONFLICT DO NOTHING').run(rootId, JSON.stringify(items))
      : db.prepare('UPDATE agent_plans SET revision = revision + 1, items_json = ? WHERE root_session_id = ? AND revision = ?').run(JSON.stringify(items), rootId, revision);
    if (!result.changes) throw new Error('Plan revision changed. Read the plan before updating it.');
    return this.plan(rootId);
  }

  enqueue(message: AgentInboxMessage, dedupeKey: string): boolean {
    return Boolean(this.database().prepare(`INSERT OR IGNORE INTO agent_messages
      (id, from_session_id, to_session_id, source_run_id, kind, text, wake, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.fromSessionId, message.toSessionId, message.sourceRunId, message.kind, message.text, Number(message.wake), dedupeKey).changes);
  }

  pending(sessionId: string): AgentInboxMessage[] {
    return this.database().prepare('SELECT * FROM agent_messages WHERE to_session_id = ? AND consumed = 0 ORDER BY rowid').all(sessionId)
      .map((row) => ({ id: String(row.id), fromSessionId: String(row.from_session_id), toSessionId: String(row.to_session_id),
        sourceRunId: String(row.source_run_id), kind: row.kind as AgentInboxMessage['kind'], text: String(row.text), wake: Boolean(row.wake) }));
  }

  acknowledge(id: string): void { this.database().prepare('UPDATE agent_messages SET consumed = 1 WHERE id = ?').run(id); }
  suppressWake(sessionId: string): void { this.database().prepare('UPDATE agent_messages SET wake = 0 WHERE to_session_id = ?').run(sessionId); }
}
