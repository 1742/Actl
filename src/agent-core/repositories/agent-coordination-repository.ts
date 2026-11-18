import type {
  AgentMail, AgentMessagePurpose, AgentPlan, AgentTask, AgentTaskInput, AgentTaskState, PlanItem, TaskAttempt,
} from '../../shared/agent/coordination.js';

export const directoryStates = ['idle', 'running', 'waiting', 'waiting_permission', 'assigned', 'stopped'] as const;
export type DirectoryState = (typeof directoryStates)[number];

export type WaitCondition =
  | { kind: 'mail'; from?: string | undefined; replyTo?: string | undefined; purpose?: AgentMessagePurpose | undefined }
  | { kind: 'task_state'; task: string; states: AgentTaskState[] }
  | { kind: 'agent_state'; agent: string; states: DirectoryState[] }
  | { kind: 'run_finished'; agent: string; run: string };

export interface AgentWait {
  id: string;
  rootId: string;
  sessionId: string;
  condition: WaitCondition;
  cursor: number;
  deadline: number;
  runId: string;
  interruptedCallId: string | null;
}

export type WaitOutcome =
  | { kind: 'mail'; message: AgentMail }
  | { kind: 'task_state'; task: string; state: AgentTaskState }
  | { kind: 'agent_state'; agent: string; state: DirectoryState }
  | { kind: 'run_finished'; run: string; state: string; output?: string }
  | { kind: 'timed_out' };

export interface MailFilter {
  from?: string | undefined;
  keyword?: string | undefined;
  subject?: string | undefined;
  since?: number | undefined;
  until?: number | undefined;
  purpose?: AgentMessagePurpose | undefined;
  unread?: boolean | undefined;
  thread?: string | undefined;
  limit: number;
}

export type Assignment =
  | { kind: 'delegate'; sourceRunId: string }
  | { kind: 'claim'; runId: string };

export type TaskDecision =
  | { kind: 'accept' }
  | { kind: 'retry' }
  | { kind: 'reject'; reason: string }
  | { kind: 'cancel'; reason: string };

export type CoordinationEvent =
  | { id: number; rootId: string; kind: 'run_finished'; runId: string }
  | { id: number; rootId: string; kind: 'task_changed'; taskId: string; state: AgentTaskState }
  | { id: number; rootId: string; kind: 'agent_changed'; agentId: string; state: DirectoryState }
  | { id: number; rootId: string; kind: 'review_requested'; resultId: string; reviewerId: string }
  | { id: number; rootId: string; kind: 'mail_received'; mailId: string };

export interface ReviewNotification {
  eventId: number;
  taskNumber: number;
  resultId: string;
}

export type WaitReceipt =
  | { kind: 'settled'; waitId: string; mailIds?: readonly string[] }
  | { kind: 'interrupted'; waitId: string; callId: string; mailIds: readonly string[] };

export interface RunActivation {
  work: { kind: 'conversation' } | { kind: 'attempt'; attemptId: string };
  mailIds: string[];
  /** agent coordination events ids */
  notificationIds: number[];
}

export interface PlanStore {
  plan(rootId: string): AgentPlan;
  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan;
}

export interface TaskStore {
  tasks(rootId: string): AgentTask[];
  task(rootId: string, taskId: string): AgentTask | undefined;
  activeTask(rootId: string, agentId: string): AgentTask | undefined;
  attemptHistory(rootId: string, taskId: string): TaskAttempt[];
  taskSourceRun(attemptId: string): string;
  taskSourceRuns(rootId: string): ReadonlyMap<string, string>;
  createTask(rootId: string, publisherId: string, draft: AgentTaskInput, operation: string): AgentTask;
  assignTask(rootId: string, taskId: string, agentId: string, assignment: Assignment, operation: string): AgentTask;
  assignmentOwner(operation: string, taskId: string): string | undefined;
  requestAssignment(rootId: string, taskId: string): void;
  decideTask(rootId: string, taskId: string, actorId: string, decision: TaskDecision, operation?: string): AgentTask;
  failAttempt(attemptId: string, reason: string): void;
  stopAgent(rootId: string, agentId: string): void;
  isStopped(agentId: string): boolean;
  enableAgent(agentId: string): void;
  finishRun(runId: string): void;
  expiredAttempts(rootId: string, now: number): string[];
  renewAttempt(attemptId: string, now: number): void;
}

export interface MailboxStore {
  sendMail(mail: Omit<AgentMail, 'id' | 'number' | 'createdAt' | 'readAt' | 'threadId'>, operation: string): AgentMail;
  sentMail(sessionId: string, operation: string): AgentMail | undefined;
  mail(rootId: string, ref: string | number): AgentMail | undefined;
  searchMail(sessionId: string, filter: MailFilter): AgentMail[];
  pendingMail(sessionId: string): AgentMail[];
  replies(sessionId: string, messageId: string): AgentMail[];
  unansweredQuestions(sessionId: string): AgentMail[];
  acknowledgeMail(sessionId: string, id: string): void;
  readMail(sessionId: string, id: string): void;
}

export interface WaitStore {
  wait(sessionId: string): AgentWait | undefined;
  registerWait(wait: Omit<AgentWait, 'id' | 'interruptedCallId'>): AgentWait;
  eventCursor(): number;
  observedTaskState(rootId: string, taskId: string, states: AgentTaskState[], cursor: number, deadline: number): AgentTaskState | undefined;
  observedAgentState(rootId: string, agentId: string, states: DirectoryState[], cursor: number, deadline: number): DirectoryState | undefined;
  resumeWait(wait: AgentWait): void;
}

export interface CoordinationOutbox {
  pendingEvents(): CoordinationEvent[];
  dispatchEvent(id: number): void;
  reviewNotifications(sessionId: string): ReviewNotification[];
  rootsWithWork(): string[];
}

export interface AgentCoordinationRepository extends PlanStore, TaskStore, MailboxStore, WaitStore, CoordinationOutbox {}
