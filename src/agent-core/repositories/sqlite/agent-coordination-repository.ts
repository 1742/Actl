import type { DatabaseSync } from 'node:sqlite';
import type { AgentInboxMessage, AgentPlan, PlanItem } from '../../../shared/agent/coordination.js';
import type { AgentCoordinationRepository } from '../agent-coordination-repository.js';

export class SqliteAgentCoordinationRepository implements AgentCoordinationRepository {
  constructor(private readonly db: DatabaseSync) {}

  plan(rootId: string): AgentPlan {
    const row = this.db.prepare('SELECT revision, items_json FROM agent_plans WHERE root_session_id = ?').get(rootId);
    return row ? { revision: Number(row.revision), items: JSON.parse(String(row.items_json)) as PlanItem[] } : { revision: 0, items: [] };
  }

  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan {
    const result = revision === 0
      ? this.db.prepare('INSERT INTO agent_plans(root_session_id, revision, items_json) VALUES (?, 1, ?) ON CONFLICT DO NOTHING').run(rootId, JSON.stringify(items))
      : this.db.prepare('UPDATE agent_plans SET revision = revision + 1, items_json = ? WHERE root_session_id = ? AND revision = ?').run(JSON.stringify(items), rootId, revision);
    if (!result.changes) throw new Error('Plan revision changed. Read the plan before updating it.');
    return this.plan(rootId);
  }

  enqueue(message: AgentInboxMessage, dedupeKey: string): string {
    const result = this.db.prepare(`INSERT INTO agent_messages
      (id, from_session_id, to_session_id, source_run_id, kind, text, wake, dedupe_key, author, model, relationship, purpose, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(message.id, message.fromSessionId, message.toSessionId, message.sourceRunId, message.kind,
        message.text, Number(message.wake), dedupeKey, message.author ?? null, message.model ?? null,
        message.relationship ?? null, message.purpose ?? null, message.replyTo ?? null);
    if (result.changes) return message.id;
    const existing = this.messageFromToolCall(dedupeKey);
    if (!existing) throw new Error('Duplicate agent message could not be found.');
    return existing.id;
  }

  messageFromToolCall(dedupeKey: string): AgentInboxMessage | undefined {
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE dedupe_key = ?').get(dedupeKey);
    return row && inboxMessage(row);
  }

  getMessage(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined {
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE id = ? AND from_session_id = ? AND to_session_id = ?')
      .get(id, fromSessionId, toSessionId);
    return row && inboxMessage(row);
  }

  findReply(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_messages
      WHERE reply_to = ? AND from_session_id = ? AND to_session_id = ? ORDER BY rowid LIMIT 1`)
      .get(id, fromSessionId, toSessionId);
    return row && inboxMessage(row);
  }

  unansweredClarifications(fromSessionId: string, toSessionId: string, sourceRunId: string): AgentInboxMessage[] {
    return this.db.prepare(`SELECT question.* FROM agent_messages question
      WHERE question.from_session_id = ? AND question.to_session_id = ? AND question.source_run_id = ?
        AND question.purpose = 'clarification' AND NOT EXISTS (
          SELECT 1 FROM agent_messages reply WHERE reply.reply_to = question.id
            AND reply.from_session_id = question.to_session_id AND reply.to_session_id = question.from_session_id
        )
      ORDER BY question.rowid`).all(fromSessionId, toSessionId, sourceRunId).map(inboxMessage);
  }

  pending(sessionId: string): AgentInboxMessage[] {
    return this.db.prepare('SELECT * FROM agent_messages WHERE to_session_id = ? AND consumed = 0 ORDER BY rowid').all(sessionId)
      .map(inboxMessage);
  }

  acknowledge(id: string): void { this.db.prepare('UPDATE agent_messages SET consumed = 1 WHERE id = ?').run(id); }
  suppressWake(sessionId: string): void { this.db.prepare('UPDATE agent_messages SET wake = 0 WHERE to_session_id = ?').run(sessionId); }
}

function inboxMessage(row: Record<string, unknown>): AgentInboxMessage {
  return {
    id: String(row.id), fromSessionId: String(row.from_session_id), toSessionId: String(row.to_session_id),
    sourceRunId: String(row.source_run_id), kind: 'message', text: String(row.text), wake: Boolean(row.wake),
    ...(row.author ? { author: row.author as NonNullable<AgentInboxMessage['author']> } : {}),
    ...(row.model ? { model: String(row.model) } : {}),
    ...(row.relationship ? { relationship: row.relationship as NonNullable<AgentInboxMessage['relationship']> } : {}),
    ...(row.purpose ? { purpose: row.purpose as NonNullable<AgentInboxMessage['purpose']> } : {}),
    ...(row.reply_to ? { replyTo: String(row.reply_to) } : {}),
  };
}
