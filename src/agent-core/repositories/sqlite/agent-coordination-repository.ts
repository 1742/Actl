import type { DatabaseSync } from 'node:sqlite';
import type { AgentInboxMessage, AgentMail, AgentMailFilter, AgentMailSummary, AgentPlan, PlanItem } from '../../../shared/agent/coordination.js';
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

  enqueue(message: AgentInboxMessage, dedupeKey: string): boolean {
    return Boolean(this.db.prepare(`INSERT OR IGNORE INTO agent_messages
      (id, from_session_id, to_session_id, source_run_id, kind, text, wake, dedupe_key, author, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.fromSessionId, message.toSessionId, message.sourceRunId, message.kind,
        message.text, Number(message.wake), dedupeKey, message.author ?? null, message.model ?? null).changes);
  }

  pending(sessionId: string): AgentInboxMessage[] {
    return this.db.prepare('SELECT * FROM agent_messages WHERE to_session_id = ? AND consumed = 0 ORDER BY rowid').all(sessionId)
      .map((row) => ({ id: String(row.id), fromSessionId: String(row.from_session_id), toSessionId: String(row.to_session_id),
        sourceRunId: String(row.source_run_id), kind: 'message', text: String(row.text), wake: Boolean(row.wake),
        ...(row.author ? { author: row.author as 'user' | 'model' } : {}),
        ...(row.model ? { model: String(row.model) } : {}) }));
  }

  sendMail(mail: AgentMail, dedupeKey: string): boolean {
    return Boolean(this.db.prepare(`INSERT INTO agent_mail
      (id, from_session_id, to_session_id, source_run_id, kind, subject, body, sent_at, is_read, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(mail.id, mail.fromSessionId, mail.toSessionId, mail.sourceRunId, mail.kind,
        mail.subject, mail.body, mail.sentAt, Number(mail.read), dedupeKey).changes);
  }

  listMail(sessionId: string, filter: AgentMailFilter): AgentMailSummary[] {
    const sender = filter.fromSessionId ?? null;
    const isRead = filter.unread === undefined ? null : Number(!filter.unread);
    return this.db.prepare(`SELECT id, from_session_id, to_session_id, source_run_id, kind, subject, sent_at, is_read
      FROM agent_mail WHERE to_session_id = ?
      AND (? IS NULL OR from_session_id = ?) AND (? IS NULL OR is_read = ?)
      AND (? IS NULL OR rowid < (SELECT rowid FROM agent_mail WHERE id = ? AND to_session_id = ?))
      ORDER BY rowid DESC LIMIT ?`)
      .all(sessionId, sender, sender, isRead, isRead, filter.beforeId ?? null, filter.beforeId ?? null,
        sessionId, filter.limit).map(mailSummary);
  }

  readMail(sessionId: string, id: string): AgentMail | undefined {
    const row = this.db.prepare('UPDATE agent_mail SET is_read = 1 WHERE id = ? AND to_session_id = ? RETURNING *').get(id, sessionId);
    return row ? { ...mailSummary(row), body: String(row.body) } : undefined;
  }

  acknowledge(id: string): void { this.db.prepare('UPDATE agent_messages SET consumed = 1 WHERE id = ?').run(id); }
  suppressWake(sessionId: string): void { this.db.prepare('UPDATE agent_messages SET wake = 0 WHERE to_session_id = ?').run(sessionId); }
}

function mailSummary(row: Record<string, unknown>): AgentMailSummary {
  return {
    id: String(row.id), fromSessionId: String(row.from_session_id), toSessionId: String(row.to_session_id),
    sourceRunId: String(row.source_run_id), kind: row.kind as AgentMailSummary['kind'],
    subject: String(row.subject), sentAt: typeof row.sent_at === 'string' ? row.sent_at : null,
    read: Boolean(row.is_read),
  };
}
