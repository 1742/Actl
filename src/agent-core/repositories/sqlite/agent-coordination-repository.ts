import type { DatabaseSync } from 'node:sqlite';
import type { AgentInboxMessage, AgentPlan, AgentTask, AgentTaskDelegationReceipt, AgentTaskInput, PlanItem } from '../../../shared/agent/coordination.js';
import { createRandomId } from '../../utils.js';
import type { AgentCoordinationRepository } from '../agent-coordination-repository.js';
import { withSqliteTransaction } from './database.js';

const TASKS_QUERY = `SELECT task.*, task.status = 'pending' AND NOT EXISTS (
  SELECT 1 FROM json_each(task.blocked_by_json) dependency
  JOIN agent_tasks blocker ON blocker.id = dependency.value
  WHERE blocker.status <> 'completed'
) AS ready FROM agent_tasks task WHERE task.root_session_id = ?`;

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

  tasks(rootId: string): AgentTask[] {
    return this.db.prepare(`${TASKS_QUERY} ORDER BY task.rowid`).all(rootId).map(toTask);
  }

  task(rootId: string, taskId: string): AgentTask | undefined {
    const row = this.db.prepare(`${TASKS_QUERY} AND task.id = ?`).get(rootId, taskId);
    return row && toTask(row);
  }

  activeTask(rootId: string, ownerSessionId: string): AgentTask | undefined {
    const row = this.db.prepare(`${TASKS_QUERY} AND task.owner_session_id = ? AND task.status = 'in_progress'`)
      .get(rootId, ownerSessionId);
    return row && toTask(row);
  }

  createTask(rootId: string, draft: AgentTaskInput, dedupeKey: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      const prior = this.db.prepare(`${TASKS_QUERY} AND task.creation_key = ?`).get(rootId, dedupeKey);
      if (prior) return toTask(prior);
      const root = this.db.prepare('SELECT id FROM sessions WHERE id = ? AND parent_session_id IS NULL').get(rootId);
      if (!root) throw new Error('Task board must belong to a root session.');
      const blockedBy = draft.blockedBy ?? [];
      if (new Set(blockedBy).size !== blockedBy.length) throw new Error('Task dependencies must be distinct.');
      for (const dependency of blockedBy) this.requireTask(rootId, dependency);
      const id = createRandomId('task');
      this.db.prepare(`INSERT INTO agent_tasks(root_session_id, id, title, instructions, acceptance_criteria, blocked_by_json, creation_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(rootId, id, draft.title, draft.instructions, draft.acceptanceCriteria,
        JSON.stringify(blockedBy), dedupeKey);
      return this.requireTask(rootId, id);
    });
  }

  claimTask(rootId: string, taskId: string, expectedRevision: number, ownerSessionId: string, assignmentId: string,
    sourceRunId: string, dedupeKey: string): AgentTask {
    return withSqliteTransaction(this.db, () => this.assignTask(rootId, taskId, expectedRevision, ownerSessionId,
      assignmentId, sourceRunId, dedupeKey));
  }

  delegateTask(rootId: string, taskId: string, expectedRevision: number, assignmentId: string,
    message: AgentInboxMessage, dedupeKey: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      if (message.fromSessionId !== rootId || message.toSessionId === rootId || message.purpose !== 'task') {
        throw new Error('The root must dispatch task messages to a direct child.');
      }
      const task = this.assignTask(rootId, taskId, expectedRevision, message.toSessionId, assignmentId,
        message.sourceRunId, dedupeKey, message.id);
      if (task.assignmentId === assignmentId && task.dispatchMessageId === message.id) {
        const storedId = this.enqueue({ ...message, taskId, assignmentId }, dedupeKey);
        if (storedId !== message.id) throw new Error('Task dispatch receipt conflicts with an existing message.');
      }
      return task;
    });
  }

  delegationReceipt(dedupeKey: string): AgentTaskDelegationReceipt | undefined {
    const row = this.db.prepare(`SELECT id, task_id, owner_session_id, message_id FROM agent_task_assignments
      WHERE operation_key = ? AND message_id IS NOT NULL`).get(dedupeKey);
    return row && { assignmentId: String(row.id), taskId: String(row.task_id), sessionId: String(row.owner_session_id),
      messageId: String(row.message_id) };
  }

  releaseTask(rootId: string, taskId: string, expectedRevision: number): AgentTask {
    return withSqliteTransaction(this.db, () => {
      const task = this.requireActiveTask(rootId, taskId, expectedRevision);
      this.retireAssignment(rootId, task.assignmentId);
      const result = this.db.prepare(`UPDATE agent_tasks SET status = 'pending', revision = revision + 1,
        owner_session_id = NULL, assignment_id = NULL, assignment_run_id = NULL, dispatch_message_id = NULL
        WHERE id = ? AND root_session_id = ? AND revision = ?`).run(taskId, rootId, expectedRevision);
      if (!result.changes) throw new Error('Task revision changed. Read the task and retry.');
      return this.requireTask(rootId, taskId);
    });
  }

  completeTask(rootId: string, taskId: string, expectedRevision: number, resultRunId: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      const task = this.requireActiveTask(rootId, taskId, expectedRevision);
      this.retireAssignment(rootId, task.assignmentId);
      const result = this.db.prepare(`UPDATE agent_tasks SET status = 'completed', revision = revision + 1, result_run_id = ?
        WHERE id = ? AND root_session_id = ? AND revision = ?`).run(resultRunId, taskId, rootId, expectedRevision);
      if (!result.changes) throw new Error('Task revision changed. Read the task and retry.');
      return this.requireTask(rootId, taskId);
    });
  }

  private assignTask(rootId: string, taskId: string, expectedRevision: number, ownerSessionId: string,
    assignmentId: string, sourceRunId: string, dedupeKey: string, messageId?: string): AgentTask {
    const task = this.requireTask(rootId, taskId);
    const prior = this.db.prepare('SELECT * FROM agent_task_assignments WHERE operation_key = ?').get(dedupeKey);
    if (prior) {
      if (prior.task_id !== taskId || prior.owner_session_id !== ownerSessionId || prior.source_run_id !== sourceRunId ||
        Boolean(prior.message_id) !== Boolean(messageId)) throw new Error('This tool call already used a different task assignment.');
      if (prior.id !== task.assignmentId || task.status !== 'in_progress') throw new Error('This task assignment has ended.');
      return task;
    }
    this.assertRevision(task, expectedRevision);
    if (!task.ready) throw new Error('Task is not ready to be assigned.');
    const member = this.db.prepare(`SELECT id FROM sessions WHERE id = ? AND (id = ? OR parent_session_id = ?)`)
      .get(ownerSessionId, rootId, rootId);
    if (!member) throw new Error('Task owner must belong to this agent tree.');
    if (this.activeTask(rootId, ownerSessionId)) throw new Error('Task owner already has an active task.');
    const result = this.db.prepare(`UPDATE agent_tasks SET status = 'in_progress', revision = revision + 1,
      owner_session_id = ?, assignment_id = ?, assignment_run_id = ?, dispatch_message_id = ?
      WHERE id = ? AND root_session_id = ? AND revision = ?`).run(ownerSessionId, assignmentId,
      messageId ? null : sourceRunId, messageId ?? null, taskId, rootId, expectedRevision);
    if (!result.changes) throw new Error('Task revision changed. Read the task and retry.');
    this.db.prepare(`INSERT INTO agent_task_assignments(id, task_id, operation_key, owner_session_id, source_run_id, message_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(assignmentId, taskId, dedupeKey, ownerSessionId, sourceRunId, messageId ?? null);
    return this.requireTask(rootId, taskId);
  }

  private requireTask(rootId: string, taskId: string): AgentTask {
    const task = this.task(rootId, taskId);
    if (!task) throw new Error('Task does not belong to this agent tree.');
    return task;
  }

  private requireActiveTask(rootId: string, taskId: string, expectedRevision: number): AgentTask & { assignmentId: string } {
    const task = this.requireTask(rootId, taskId);
    this.assertRevision(task, expectedRevision);
    if (task.status !== 'in_progress' || !task.assignmentId) throw new Error('Task has no active assignment.');
    return { ...task, assignmentId: task.assignmentId };
  }

  private assertRevision(task: AgentTask, expectedRevision: number): void {
    if (task.revision !== expectedRevision) throw new Error(`Task revision changed to ${task.revision}. Read the task and retry.`);
  }

  private retireAssignment(rootId: string, assignmentId: string): void {
    this.db.prepare(`UPDATE agent_messages SET consumed = 1, wake = 0 WHERE assignment_id = ? AND consumed = 0
      AND from_session_id = ?`).run(assignmentId, rootId);
  }

  enqueue(message: AgentInboxMessage, dedupeKey: string): string {
    const result = this.db.prepare(`INSERT INTO agent_messages
      (id, from_session_id, to_session_id, source_run_id, kind, text, wake, dedupe_key, author, model, relationship, purpose, reply_to,
       task_id, assignment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(message.id, message.fromSessionId, message.toSessionId, message.sourceRunId, message.kind,
        message.text, Number(message.wake), dedupeKey, message.author ?? null, message.model ?? null,
        message.relationship ?? null, message.purpose ?? null, message.replyTo ?? null, message.taskId ?? null, message.assignmentId ?? null);
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

function toTask(row: Record<string, unknown>): AgentTask {
  const ownerSessionId = row.owner_session_id ? String(row.owner_session_id) : undefined;
  return {
    id: String(row.id), rootSessionId: String(row.root_session_id), title: String(row.title), instructions: String(row.instructions),
    acceptanceCriteria: String(row.acceptance_criteria), blockedBy: JSON.parse(String(row.blocked_by_json)) as string[],
    status: row.status as AgentTask['status'], revision: Number(row.revision), ready: Boolean(row.ready),
    ...(ownerSessionId ? { ownerSessionId } : {}),
    ...(row.assignment_id ? { assignmentId: String(row.assignment_id) } : {}),
    ...(row.assignment_run_id ? { assignmentRunId: String(row.assignment_run_id) } : {}),
    ...(row.dispatch_message_id ? { dispatchMessageId: String(row.dispatch_message_id) } : {}),
    ...(ownerSessionId && row.result_run_id ? { result: { sessionId: ownerSessionId, runId: String(row.result_run_id) } } : {}),
  };
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
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    ...(row.assignment_id ? { assignmentId: String(row.assignment_id) } : {}),
  };
}
