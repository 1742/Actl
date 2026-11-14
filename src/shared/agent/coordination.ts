import type { AgentSession } from './sessions.js';
import type { AgentStreamEvent, AgentResponseDto } from './responses.js';

export interface PlanItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface AgentPlan { revision: number; items: PlanItem[] }

export interface AgentTaskInput {
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  blockedBy?: string[] | undefined;
}

export interface AgentTask extends AgentTaskInput {
  id: string;
  rootSessionId: string;
  blockedBy: string[];
  status: 'pending' | 'in_progress' | 'completed';
  revision: number;
  ready: boolean;
  ownerSessionId?: string;
  assignmentId?: string;
  assignmentRunId?: string;
  dispatchMessageId?: string;
  result?: { sessionId: string; runId: string };
}

export interface AgentTaskDelegationReceipt {
  taskId: string;
  assignmentId: string;
  sessionId: string;
  messageId: string;
}

export interface AgentTreeMember {
  session: AgentSession;
  response?: AgentResponseDto;
  sequenceNumber?: number;
}
export interface AgentTreeSnapshot {
  rootSessionId: string;
  members: AgentTreeMember[];
  plan: AgentPlan;
  tasks?: AgentTask[];
}
export type AgentTreeEvent =
  | { type: 'snapshot'; snapshot: AgentTreeSnapshot }
  | { type: 'response'; rootSessionId: string; sessionId: string; events: AgentStreamEvent[] }
  | { type: 'changed'; rootSessionId: string };

export type AgentMessageRelationship = 'parent' | 'child';
export type AgentMessagePurpose = 'task' | 'message' | 'progress' | 'clarification';

export interface AgentInboxMessage {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  sourceRunId: string;
  kind: 'message';
  author?: 'user' | 'model';
  model?: string;
  relationship?: AgentMessageRelationship;
  purpose?: AgentMessagePurpose;
  replyTo?: string;
  taskId?: string;
  assignmentId?: string;
  text: string;
  wake: boolean;
}
