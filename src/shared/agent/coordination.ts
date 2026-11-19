import type { AgentSession } from './sessions.js';
import type { AgentItemDto, AgentStreamEvent, AgentResponseDto } from './responses.js';

export interface PlanItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface AgentPlan { revision: number; items: PlanItem[] }

export const agentTaskStates = ['pending', 'assigned', 'running', 'review_required', 'completed', 'failed', 'cancelled'] as const;
export type AgentTaskState = (typeof agentTaskStates)[number];
export type AgentTaskPendingReason = 'dependencies' | 'unassigned' | 'no_idle_agent';

export interface AgentTaskInput {
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  type: string;
  blockedBy?: string[] | undefined;
  autoAssign?: boolean | undefined;
}

export interface TaskResult {
  id: string;
  runId: string;
  output: string;
}

export interface TaskAttempt {
  id: string;
  ownerSessionId: string;
  startedAt: number;
  outcome: 'active' | 'submitted' | 'accepted' | 'rejected' | 'failed' | 'cancelled';
  reason?: string;
  result?: TaskResult;
}

export interface AgentTask extends AgentTaskInput {
  id: string;
  number: number;
  rootSessionId: string;
  reviewerSessionId: string;
  blockedBy: string[];
  status: AgentTaskState;
  ready: boolean;
  autoAssign: boolean;
  pendingReason?: AgentTaskPendingReason;
  attempt?: TaskAttempt;
}

export interface AgentTreeMember {
  session: AgentSession;
  waiting?: boolean;
  response?: AgentResponseDto;
  sequenceNumber?: number;
}

export interface ChildRunResult {
  parentRunId: string;
  sessionId: string;
  runId: string;
  hasFileChanges: boolean;
  searchOutput: AgentItemDto[];
}

export interface AgentTreeSnapshot {
  rootSessionId: string;
  members: AgentTreeMember[];
  plan: AgentPlan;
  tasks?: AgentTask[];
  childRunResults: ChildRunResult[];
}
export type AgentTreeEvent =
  | { type: 'snapshot'; snapshot: AgentTreeSnapshot }
  | { type: 'response'; rootSessionId: string; sessionId: string; events: AgentStreamEvent[] }
  | { type: 'changed'; rootSessionId: string };

export type AgentMessageRelationship = 'parent' | 'child' | 'peer';
export const agentMailPurposes = ['information', 'question', 'progress', 'urgent'] as const;
export type AgentMessagePurpose = (typeof agentMailPurposes)[number];

export interface AgentMail {
  id: string;
  number: number;
  rootId: string;
  fromSessionId: string;
  toSessionId: string;
  subject: string;
  body: string;
  purpose: AgentMessagePurpose;
  createdAt: number;
  readAt: number | null;
  author: 'user' | 'model';
  threadId: string;
  replyTo: string | null;
}
