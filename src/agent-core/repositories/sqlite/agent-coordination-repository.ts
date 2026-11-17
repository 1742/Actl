import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AgentMail, AgentPlan, AgentTask, AgentTaskInput, AgentTaskState, PlanItem, TaskAttempt } from '../../../shared/agent/coordination.js';
import type {
  AgentCoordinationRepository, AgentWait, Assignment, CoordinationEvent, DirectoryState, MailFilter, ReviewNotification, RunActivation, TaskDecision, WaitReceipt,
} from '../agent-coordination-repository.js';
import type { AgentRunRecord } from '../../runtime/agent-domain.js';
import { createRandomId } from '../../utils.js';
import { withSqliteTransaction } from './database.js';

const LEASE_MS = 60000;

/** select task in one tree */
const TASK_QUERY = `SELECT task.*, task.status = 'pending' AND NOT EXISTS (
  SELECT 1 FROM agent_task_dependencies d JOIN agent_tasks blocker ON blocker.id = d.dependency_id
  WHERE d.task_id = task.id AND blocker.status <> 'completed'
) AS ready FROM agent_tasks task WHERE task.root_id = ?`;

const ATTEMPT_QUERY = `SELECT a.*, result.id AS result_id, result.run_id, run.final_output
  FROM agent_task_attempts a LEFT JOIN agent_results result ON result.attempt_id = a.id
  LEFT JOIN agent_runs run ON run.id = result.run_id WHERE a.task_id = ?`;

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
    if (!result.changes) throw new Error('Plan revision changed. Read the plan before replacing it.');
    return this.plan(rootId);
  }

  tasks(rootId: string): AgentTask[] {
    return this.db.prepare(`${TASK_QUERY} ORDER BY task.number`).all(rootId).map((row) => this.toTask(row));
  }

  task(rootId: string, taskId: string): AgentTask | undefined {
    const row = this.db.prepare(`${TASK_QUERY} AND task.id = ?`).get(rootId, taskId);
    return row && this.toTask(row);
  }

  /** Search specific agent's active task */
  activeTask(rootId: string, agentId: string): AgentTask | undefined {
    const row = this.db.prepare(`${TASK_QUERY} AND EXISTS (
      SELECT 1 FROM agent_task_attempts a WHERE a.task_id = task.id AND a.owner_id = ? AND a.outcome = 'active'
    )`).get(rootId, agentId);
    return row && this.toTask(row);
  }

  attemptHistory(rootId: string, taskId: string): TaskAttempt[] {
    this.requireTask(rootId, taskId);
    return this.db.prepare(`${ATTEMPT_QUERY} ORDER BY a.rowid`).all(taskId).map(toAttempt);
  }

  /** Find task attempt source run id. */
  taskSourceRun(attemptId: string): string {
    const row = this.db.prepare('SELECT source_run_id FROM agent_task_attempts WHERE id = ?').get(attemptId);
    if (!row) throw new Error('Unknown task attempt.');
    return String(row.source_run_id);
  }

  /** @returns Key: run id of the task execution. Value: task source run id. */
  taskSourceRuns(rootId: string): ReadonlyMap<string, string> {
    const rows = this.db.prepare(`SELECT link.run_id, attempt.source_run_id
      FROM agent_tasks task
      JOIN agent_task_attempts attempt ON attempt.task_id = task.id
      JOIN agent_attempt_runs link ON link.attempt_id = attempt.id
      WHERE task.root_id = ?`).all(rootId);
    return new Map(rows.map((row) => [String(row.run_id), String(row.source_run_id)]));
  }

  createTask(rootId: string, publisherId: string, draft: AgentTaskInput, operation: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      this.assertMember(rootId, publisherId);
      const existing = this.db.prepare(`${TASK_QUERY} AND task.creation_key = ?`).get(rootId, operation);
      if (existing) return this.toTask(existing);
      const dependencies = [...new Set(draft.blockedBy ?? [])];
      for (const dependency of dependencies) this.requireTask(rootId, dependency);
      const id = createRandomId('task');
      this.db.prepare(`INSERT INTO agent_tasks(id, number, root_id, reviewer_id, type, title, instructions, acceptance_criteria, auto_assign, creation_key)
        SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? FROM agent_tasks WHERE root_id = ?`)
        .run(id, rootId, publisherId, draft.type, draft.title, draft.instructions, draft.acceptanceCriteria, Number(draft.autoAssign ?? true), operation, rootId);
      for (const dependency of dependencies) {
        this.db.prepare('INSERT INTO agent_task_dependencies(task_id, dependency_id) VALUES (?, ?)').run(id, dependency);
      }
      this.emit(rootId, 'task_changed', id, null, 'pending');
      return this.requireTask(rootId, id);
    });
  }

  assignTask(rootId: string, taskId: string, agentId: string, assignment: Assignment, operation: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      this.assertMember(rootId, agentId);
      const task = this.requireTask(rootId, taskId);
      const prior = this.db.prepare('SELECT task_id, owner_id FROM agent_task_attempts WHERE operation_key = ?').get(operation);
      if (prior) {
        if (prior.task_id !== taskId || prior.owner_id !== agentId) throw new Error('This operation assigned a different task or agent.');
        return task;
      }
      if (!task.ready) throw new Error('Task is no longer ready to be assigned.');
      if (this.isStopped(agentId) || this.activeTask(rootId, agentId)) throw new Error('Agent is unavailable for a task.');
      const id = createRandomId('attempt');
      const now = Date.now();
      this.db.prepare(`INSERT INTO agent_task_attempts(id, task_id, owner_id, source_run_id, operation_key, started_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, agentId, assignment.kind === 'claim' ? assignment.runId : assignment.sourceRunId, operation, now, now + LEASE_MS);
      if (assignment.kind === 'claim') {
        const run = this.db.prepare("SELECT id FROM agent_runs WHERE id = ? AND session_id = ? AND status = 'in_progress'").get(assignment.runId, agentId);
        if (!run) throw new Error('Claim requires an active run owned by the claimant.');
        this.db.prepare('INSERT INTO agent_attempt_runs(run_id, attempt_id) VALUES (?, ?)').run(assignment.runId, id);
      }
      this.changeState(task, assignment.kind === 'claim' ? 'running' : 'assigned');
      if (assignment.kind === 'delegate') this.emit(rootId, 'agent_changed', agentId, null, 'assigned');
      return this.requireTask(rootId, taskId);
    });
  }

  assignmentOwner(operation: string, taskId: string): string | undefined {
    const row = this.db.prepare('SELECT owner_id, task_id FROM agent_task_attempts WHERE operation_key = ?').get(operation);
    if (row && row.task_id !== taskId) throw new Error('This operation already assigned a different task.');
    return row && String(row.owner_id);
  }

  requestAssignment(rootId: string, taskId: string): void {
    withSqliteTransaction(this.db, () => {
      const task = this.requireTask(rootId, taskId);
      if (!task.autoAssign) {
        this.db.prepare('UPDATE agent_tasks SET auto_assign = 1 WHERE id = ?').run(taskId);
        this.emit(rootId, 'task_changed', taskId, null, task.status);
      }
    });
  }

  decideTask(rootId: string, taskId: string, actorId: string, decision: TaskDecision, operation?: string): AgentTask {
    return withSqliteTransaction(this.db, () => {
      const task = this.requireTask(rootId, taskId);
      if (actorId !== task.reviewerSessionId && !(decision.kind === 'cancel' && actorId === rootId)) {
        throw new Error('Only the authorized reviewer may make this decision.');
      }
      if (operation) {
        const inserted = this.db.prepare(`INSERT INTO agent_task_decisions(operation_key, task_id, actor_id, kind)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(operation, taskId, actorId, decision.kind);
        if (!inserted.changes) {
          const prior = this.db.prepare('SELECT task_id, actor_id, kind FROM agent_task_decisions WHERE operation_key = ?').get(operation);
          if (prior?.task_id !== taskId || prior.actor_id !== actorId || prior.kind !== decision.kind) {
            throw new Error('This operation already recorded a different task decision.');
          }
          return task;
        }
      }
      if (decision.kind === 'retry') {
        if (task.status !== 'failed') throw new Error('Only a failed task can be retried.');
        this.changeState(task, 'pending');
      } else if (decision.kind === 'cancel') {
        if (!['pending', 'assigned', 'running', 'review_required'].includes(task.status)) throw new Error('Task is already terminal.');
        if (task.attempt && (task.status !== 'pending')) {
          this.endAttempt(task, 'cancelled', decision.reason);
          this.deleteAttemptWait(task);
        }
        this.changeState(task, 'cancelled');
      } else {
        if (task.status !== 'review_required' || !task.attempt?.result) throw new Error('Task has no submitted result to review.');
        if (decision.kind === 'accept') {
          this.endAttempt(task, 'accepted');
          this.changeState(task, 'completed');
        } else {
          this.endAttempt(task, 'rejected', decision.reason);
          this.changeState(task, 'pending');
        }
      }
      return this.requireTask(rootId, taskId);
    });
  }

  failAttempt(attemptId: string, reason: string): void {
    withSqliteTransaction(this.db, () => {
      const task = this.taskForActiveAttempt(attemptId);
      if (!task) return;
      this.endAttempt(task, 'failed', reason);
      this.deleteAttemptWait(task);
      this.changeState(task, 'failed');
    });
  }

  stopAgent(rootId: string, agentId: string): void {
    withSqliteTransaction(this.db, () => {
      this.db.prepare('INSERT INTO agent_stopped_sessions(session_id) VALUES (?) ON CONFLICT DO NOTHING').run(agentId);
      this.db.prepare('DELETE FROM agent_waits WHERE session_id = ?').run(agentId);
      const task = this.activeTask(rootId, agentId);
      if (task) {
        this.endAttempt(task, 'cancelled', 'Agent was stopped.');
        this.changeState(task, 'cancelled');
      }
      this.emit(rootId, 'agent_changed', agentId, null, 'stopped');
    });
  }

  isStopped(agentId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM agent_stopped_sessions WHERE session_id = ?').get(agentId));
  }

  enableAgent(agentId: string): void {
    this.db.prepare('DELETE FROM agent_stopped_sessions WHERE session_id = ?').run(agentId);
  }

  finishRun(runId: string): void {
    withSqliteTransaction(this.db, () => {
      const run = this.db.prepare(`SELECT run.status, run.final_output, run.error_message, link.attempt_id
        FROM agent_runs run JOIN agent_attempt_runs link ON link.run_id = run.id WHERE run.id = ?`).get(runId);
      if (!run || !['completed', 'cancelled', 'incomplete', 'failed'].includes(String(run.status))) return;
      const task = this.taskForActiveAttempt(String(run.attempt_id));
      if (!task || task.status !== 'running') return;
      if (run.status === 'completed' && typeof run.final_output === 'string' && run.final_output.trim()) {
        const resultId = createRandomId('result');
        this.db.prepare('INSERT INTO agent_results(id, attempt_id, run_id) VALUES (?, ?, ?)').run(resultId, String(run.attempt_id), runId);
        this.endAttempt(task, 'submitted');
        this.changeState(task, 'review_required');
        this.emit(task.rootSessionId, 'review_requested', resultId, task.reviewerSessionId);
        return;
      }
      const reason = run.status === 'completed' ? 'The run supplied no final text.' : String(run.error_message ?? `Run ended as ${run.status}.`);
      this.endAttempt(task, 'failed', reason);
      this.deleteAttemptWait(task);
      this.changeState(task, 'failed');
    });
  }

  sendMail(draft: Omit<AgentMail, 'id' | 'number' | 'createdAt' | 'readAt' | 'threadId'>, operation: string): AgentMail {
    return withSqliteTransaction(this.db, () => {
      this.assertMember(draft.rootId, draft.fromSessionId);
      this.assertMember(draft.rootId, draft.toSessionId);
      if (draft.fromSessionId === draft.toSessionId) throw new Error('Choose another agent as mail recipient.');
      const existing = this.db.prepare('SELECT * FROM agent_mail WHERE operation_key = ?').get(operation);
      if (existing) {
        if (existing.sender_id !== draft.fromSessionId || existing.recipient_id !== draft.toSessionId) throw new Error('This operation used a different recipient.');
        return toMail(existing);
      }
      const original = draft.replyTo === null ? undefined : this.mail(draft.rootId, draft.replyTo);
      if (draft.replyTo && (original?.fromSessionId !== draft.toSessionId || original?.toSessionId !== draft.fromSessionId)) {
        throw new Error('replyTo must identify mail received from this agent.');
      }
      const id = createRandomId('mail');
      const row = this.db.prepare(`INSERT INTO agent_mail(id, number, root_id, sender_id, recipient_id, subject, body,
        purpose, author, created_at, thread_id, reply_to, operation_key)
        SELECT ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM agent_mail WHERE root_id = ?
        RETURNING *`).get(id, draft.rootId, draft.fromSessionId, draft.toSessionId, draft.subject, draft.body,
        draft.purpose, draft.author, Date.now(), original?.threadId ?? id, draft.replyTo, operation, draft.rootId)!;
      this.emit(draft.rootId, 'mail_received', id);
      return toMail(row);
    });
  }

  /** Search sent mails */
  sentMail(sessionId: string, operation: string): AgentMail | undefined {
    const row = this.db.prepare('SELECT * FROM agent_mail WHERE operation_key = ? AND sender_id = ?').get(operation, sessionId);
    return row && toMail(row);
  }

  mail(rootId: string, ref: string | number): AgentMail | undefined {
    const column = typeof ref === 'number' ? 'number' : 'id';
    const row = this.db.prepare(`SELECT * FROM agent_mail WHERE root_id = ? AND ${column} = ?`).get(rootId, ref);
    return row && toMail(row);
  }

  searchMail(sessionId: string, filter: MailFilter): AgentMail[] {
    const conditions = ['(recipient_id = ? OR sender_id = ?)'];
    const args: SQLInputValue[] = [sessionId, sessionId];
    const fields: Array<[string, SQLInputValue | undefined]> = [
      ['sender_id = ?', filter.from], ['purpose = ?', filter.purpose], ['thread_id = ?', filter.thread],
      ['created_at >= ?', filter.since], ['created_at <= ?', filter.until],
      ['instr(lower(subject), lower(?)) > 0', filter.subject],
    ];
    for (const [predicate, value] of fields) {
      if (value === undefined) continue;
      conditions.push(predicate);
      args.push(value);
    }
    if (filter.keyword !== undefined) {
      conditions.push("instr(lower(subject || ' ' || body), lower(?)) > 0");
      args.push(filter.keyword);
    }
    if (filter.unread !== undefined) {
      conditions.push(filter.unread ? 'recipient_id = ? AND read_at IS NULL' : 'recipient_id = ? AND read_at IS NOT NULL');
      args.push(sessionId);
    }
    return this.db.prepare(`SELECT * FROM agent_mail WHERE ${conditions.join(' AND ')} ORDER BY number DESC LIMIT ?`).all(...args, filter.limit).map(toMail);
  }

  /** Search replies for specific message */
  replies(sessionId: string, messageId: string): AgentMail[] {
    return this.db.prepare('SELECT * FROM agent_mail WHERE recipient_id = ? AND reply_to = ? ORDER BY number').all(sessionId, messageId).map(toMail);
  }

  /** Search question mails without replies */
  unansweredQuestions(sessionId: string): AgentMail[] {
    return this.db.prepare(`SELECT question.* FROM agent_mail question WHERE question.recipient_id = ? AND question.purpose = 'question'
      AND NOT EXISTS (SELECT 1 FROM agent_mail answer WHERE answer.reply_to = question.id) ORDER BY question.number LIMIT 2`)
      .all(sessionId).map(toMail);
  }

  pendingMail(sessionId: string): AgentMail[] {
    return this.db.prepare('SELECT * FROM agent_mail WHERE recipient_id = ? AND delivered = 0 ORDER BY number').all(sessionId).map(toMail);
  }

  acknowledgeMail(sessionId: string, id: string): void {
    this.db.prepare('UPDATE agent_mail SET delivered = 1 WHERE id = ? AND recipient_id = ?').run(id, sessionId);
  }

  readMail(sessionId: string, id: string): void {
    this.db.prepare('UPDATE agent_mail SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient_id = ?').run(Date.now(), id, sessionId);
  }

  wait(sessionId: string): AgentWait | undefined {
    const row = this.db.prepare('SELECT * FROM agent_waits WHERE session_id = ?').get(sessionId);
    return row && { id: String(row.id), rootId: String(row.root_id), sessionId: String(row.session_id),
      condition: JSON.parse(String(row.condition_json)) as AgentWait['condition'], cursor: Number(row.event_cursor), deadline: Number(row.deadline), runId: String(row.run_id),
      interruptedCallId: row.interrupted_call_id === null ? null : String(row.interrupted_call_id) };
  }

  registerWait(draft: Omit<AgentWait, 'id' | 'interruptedCallId'>): AgentWait {
    return withSqliteTransaction(this.db, () => {
      this.assertMember(draft.rootId, draft.sessionId);
      const active = this.db.prepare("SELECT 1 FROM agent_runs WHERE id = ? AND session_id = ? AND status = 'in_progress'")
        .get(draft.runId, draft.sessionId);
      if (!active) throw new Error('Wait requires an active run owned by this session.');
      const id = createRandomId('wait');
      this.db.prepare('INSERT INTO agent_waits(id, root_id, session_id, condition_json, deadline, event_cursor, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, draft.rootId, draft.sessionId, JSON.stringify(draft.condition), draft.deadline, draft.cursor, draft.runId);
      this.emit(draft.rootId, 'agent_changed', draft.sessionId, null, 'waiting');
      return { ...draft, id, interruptedCallId: null };
    });
  }

  eventCursor(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(id), 0) AS cursor FROM agent_coordination_events').get()?.cursor);
  }

  observedTaskState(rootId: string, taskId: string, states: AgentTaskState[], cursor: number, deadline: number): AgentTaskState | undefined {
    return this.observedState('task_changed', rootId, taskId, states, cursor, deadline);
  }

  observedAgentState(rootId: string, agentId: string, states: DirectoryState[], cursor: number, deadline: number): DirectoryState | undefined {
    return this.observedState('agent_changed', rootId, agentId, states, cursor, deadline);
  }

  /**
   * 
   * @param subjectId task_id or agent session_id
   */
  private observedState<T extends string>(kind: 'agent_changed' | 'task_changed', rootId: string, subjectId: string,
    states: T[], cursor: number, deadline: number): T | undefined {
    const row = this.db.prepare(`SELECT state FROM agent_coordination_events WHERE root_id = ? AND kind = ? AND subject_id = ?
      AND id > ? AND created_at <= ? AND state IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1`)
      .get(rootId, kind, subjectId, cursor, deadline, JSON.stringify(states));
    return row?.state as T | undefined;
  }

  /** Bind run and wait together */
  resumeWait(wait: AgentWait): void {
    withSqliteTransaction(this.db, () => {
      const updated = this.db.prepare('UPDATE agent_waits SET interrupted_call_id = NULL WHERE id = ? AND run_id = ? AND interrupted_call_id IS NOT NULL')
        .run(wait.id, wait.runId);
      if (!updated.changes) throw new Error('Only an interrupted wait can be resumed.');
      this.emit(wait.rootId, 'agent_changed', wait.sessionId, null, 'waiting');
    });
  }

  pendingEvents(): CoordinationEvent[] {
    return this.db.prepare('SELECT * FROM agent_coordination_events WHERE dispatched = 0 ORDER BY id LIMIT 200').all().map((row) => {
      const base = { id: Number(row.id), rootId: String(row.root_id) };
      const subject = String(row.subject_id);
      switch (row.kind) {
        case 'run_finished': return { ...base, kind: row.kind, runId: subject };
        case 'task_changed': return { ...base, kind: row.kind, taskId: subject, state: row.state as AgentTaskState };
        case 'agent_changed': return { ...base, kind: row.kind, agentId: subject, state: row.state as DirectoryState };
        case 'review_requested': return { ...base, kind: row.kind, resultId: subject, reviewerId: String(row.recipient_id) };
        case 'mail_received': return { ...base, kind: row.kind, mailId: subject };
        default: throw new Error('Unknown coordination event.');
      }
    });
  }

  dispatchEvent(id: number): void {
    this.db.prepare('UPDATE agent_coordination_events SET dispatched = 1 WHERE id = ?').run(id);
  }

  reviewNotifications(sessionId: string): ReviewNotification[] {
    return this.db.prepare(`SELECT event.id, event.subject_id, task.number FROM agent_coordination_events event
      JOIN agent_results result ON result.id = event.subject_id
      JOIN agent_task_attempts a ON a.id = result.attempt_id
      JOIN agent_tasks task ON task.id = a.task_id
      WHERE event.recipient_id = ? AND event.kind = 'review_requested' AND event.delivered = 0 AND a.outcome = 'submitted'
      ORDER BY event.id`).all(sessionId).map((row) => ({
      eventId: Number(row.id), taskNumber: Number(row.number), resultId: String(row.subject_id),
    }));
  }

  /** Find all root_ids that have active/pending work. */
  rootsWithWork(): string[] {
    return this.db.prepare(`SELECT root_id FROM agent_tasks WHERE status IN ('assigned','running') OR (status = 'pending' AND auto_assign = 1)
      UNION SELECT root_id FROM agent_mail WHERE delivered = 0 AND purpose IN ('question','urgent')
      UNION SELECT event.root_id FROM agent_coordination_events event
        JOIN agent_results result ON result.id = event.subject_id
        JOIN agent_task_attempts a ON a.id = result.attempt_id
        WHERE event.kind = 'review_requested' AND event.delivered = 0 AND a.outcome = 'submitted'`).all().map((row) => String(row.root_id));
  }

  /** Find all timeout attempts id for the root. */
  expiredAttempts(rootId: string, now: number): string[] {
    return this.db.prepare(`SELECT a.id FROM agent_task_attempts a JOIN agent_tasks task ON task.id = a.task_id
      WHERE task.root_id = ? AND a.outcome = 'active' AND a.lease_expires_at <= ?`).all(rootId, now).map((row) => String(row.id));
  }

  renewAttempt(attemptId: string, now: number): void {
    this.db.prepare("UPDATE agent_task_attempts SET lease_expires_at = ? WHERE id = ? AND outcome = 'active'")
      .run(now + LEASE_MS, attemptId);
  }

  private toTask(row: Record<string, unknown>): AgentTask {
    const id = String(row.id);
    const blockedBy = this.db.prepare('SELECT dependency_id FROM agent_task_dependencies WHERE task_id = ? ORDER BY rowid')
      .all(id).map((item) => String(item.dependency_id));
    const attempt = this.db.prepare(`${ATTEMPT_QUERY} ORDER BY a.rowid DESC LIMIT 1`).get(id);
    return { id, number: Number(row.number), rootSessionId: String(row.root_id), reviewerSessionId: String(row.reviewer_id),
      type: String(row.type), title: String(row.title), instructions: String(row.instructions), acceptanceCriteria: String(row.acceptance_criteria),
      blockedBy, autoAssign: Boolean(row.auto_assign), status: row.status as AgentTask['status'], ready: Boolean(row.ready),
      ...(attempt ? { attempt: toAttempt(attempt) } : {}) };
  }

  private requireTask(rootId: string, taskId: string): AgentTask {
    const task = this.task(rootId, taskId);
    if (!task) throw new Error('Task does not belong to this root.');
    return task;
  }

  private taskForActiveAttempt(attemptId: string): AgentTask | undefined {
    const row = this.db.prepare(`SELECT task.root_id, task.id FROM agent_tasks task JOIN agent_task_attempts a ON a.task_id = task.id
      WHERE a.id = ? AND a.outcome = 'active'`).get(attemptId);
    return row && this.task(String(row.root_id), String(row.id));
  }

  private changeState(task: AgentTask, status: AgentTask['status']): void {
    const result = this.db.prepare('UPDATE agent_tasks SET status = ? WHERE id = ? AND status = ?').run(status, task.id, task.status);
    if (!result.changes) throw new Error('Task state changed.');
    this.emit(task.rootSessionId, 'task_changed', task.id, null, status);
  }

  private endAttempt(task: AgentTask, outcome: TaskAttempt['outcome'], reason?: string): void {
    this.db.prepare('UPDATE agent_task_attempts SET outcome = ?, reason = ? WHERE id = ?').run(outcome, reason ?? null, task.attempt!.id);
  }

  private deleteAttemptWait(task: AgentTask): void {
    this.db.prepare('DELETE FROM agent_waits WHERE session_id = ?').run(task.attempt!.ownerSessionId);
  }

  private assertMember(rootId: string, sessionId: string): void {
    if (!this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND COALESCE(root_session_id, id) = ?').get(sessionId, rootId)) {
      throw new Error('Agent does not belong to this root.');
    }
  }

  private emit(
    rootId: string, 
    kind: CoordinationEvent['kind'], 
    subject: string, 
    recipient: string | null = null, 
    state: AgentTaskState | DirectoryState | null = null
  ): void {
    this.db.prepare('INSERT INTO agent_coordination_events(root_id, kind, subject_id, recipient_id, state) VALUES (?, ?, ?, ?, ?)')
      .run(rootId, kind, subject, recipient, state);
  }
}

/** Update task, wait, mail and event status when agent start run. */
export function activateAgentRun(db: DatabaseSync, run: AgentRunRecord, activation: RunActivation): void {
  if (activation.work.kind === 'attempt') {
    const attempt = db.prepare(`SELECT task.id, task.root_id, task.status FROM agent_task_attempts a JOIN agent_tasks task ON task.id = a.task_id
      WHERE a.id = ? AND a.owner_id = ? AND a.outcome = 'active'`).get(activation.work.attemptId, run.sessionId);
    if (!attempt) throw new Error('The task attempt no longer belongs to this agent.');
    db.prepare('INSERT INTO agent_attempt_runs(run_id, attempt_id) VALUES (?, ?)').run(run.id, activation.work.attemptId);
    if (attempt.status === 'assigned') {
      db.prepare("UPDATE agent_tasks SET status = 'running' WHERE id = ?").run(String(attempt.id));
      db.prepare("INSERT INTO agent_coordination_events(root_id, kind, subject_id, state) VALUES (?, 'task_changed', ?, 'running')")
        .run(String(attempt.root_id), String(attempt.id));
    }
  }
  for (const id of activation.mailIds) {
    db.prepare('UPDATE agent_mail SET delivered = 1 WHERE id = ? AND recipient_id = ?').run(id, run.sessionId);
  }
  for (const id of activation.notificationIds) {
    db.prepare('UPDATE agent_coordination_events SET delivered = 1 WHERE id = ? AND recipient_id = ?').run(id, run.sessionId);
  }
}

export function recordAgentWaitReceipt(db: DatabaseSync, run: AgentRunRecord, receipt: WaitReceipt): void {
  const wait = db.prepare('SELECT root_id FROM agent_waits WHERE id = ? AND run_id = ? AND session_id = ?')
    .get(receipt.waitId, run.id, run.sessionId);
  if (!wait) throw new Error('The wait is no longer active.');

  if (receipt.kind === 'interrupted') {
    db.prepare('UPDATE agent_waits SET interrupted_call_id = ? WHERE id = ?').run(receipt.callId, receipt.waitId);
  } else {
    db.prepare('DELETE FROM agent_waits WHERE id = ?').run(receipt.waitId);
    if (receipt.mailId) {
      db.prepare('UPDATE agent_mail SET delivered = 1 WHERE id = ? AND recipient_id = ?').run(receipt.mailId, run.sessionId);
    }
  }
  db.prepare("INSERT INTO agent_coordination_events(root_id, kind, subject_id, state) VALUES (?, 'agent_changed', ?, 'running')")
    .run(String(wait.root_id), run.sessionId);
}

function toAttempt(row: Record<string, unknown>): TaskAttempt {
  return { id: String(row.id), ownerSessionId: String(row.owner_id), startedAt: Number(row.started_at),
    outcome: row.outcome as TaskAttempt['outcome'], ...(row.reason === null ? {} : { reason: String(row.reason) }),
    ...(row.result_id ? { result: { id: String(row.result_id), runId: String(row.run_id), output: String(row.final_output ?? '') } } : {}) };
}

function toMail(row: Record<string, unknown>): AgentMail {
  return { id: String(row.id), number: Number(row.number), rootId: String(row.root_id), fromSessionId: String(row.sender_id),
    toSessionId: String(row.recipient_id), subject: String(row.subject), body: String(row.body), purpose: row.purpose as AgentMail['purpose'],
    author: row.author as AgentMail['author'], createdAt: Number(row.created_at), readAt: row.read_at === null ? null : Number(row.read_at),
    threadId: String(row.thread_id), replyTo: row.reply_to === null ? null : String(row.reply_to) };
}
