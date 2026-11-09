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

export interface AgentInboxMessage {
  id: string;
  fromSessionId: string;
  toSessionId: string;
  sourceRunId: string;
  kind: 'message' | 'result';
  text: string;
  wake: boolean;
}
