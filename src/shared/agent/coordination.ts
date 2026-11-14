import type { AgentSession } from './sessions.js';
import type { AgentStreamEvent, AgentResponseDto } from './responses.js';

export interface PlanItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
export interface AgentPlan { revision: number; items: PlanItem[] }
export interface AgentTreeMember {
  session: AgentSession;
  response?: AgentResponseDto;
  sequenceNumber?: number;
}
export interface AgentTreeSnapshot {
  rootSessionId: string;
  members: AgentTreeMember[];
  plan: AgentPlan;
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
  text: string;
  wake: boolean;
}
