import type { AgentInboxMessage, AgentPlan, PlanItem } from "../../shared/agent/coordination.js";

/** Durable coordination state. Delivery is acknowledged after transcript persistence. */
export interface AgentCoordinationRepository {
  plan(rootId: string): AgentPlan;
  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan;
  enqueue(message: AgentInboxMessage, dedupeKey: string): string;
  messageFromToolCall(dedupeKey: string): AgentInboxMessage | undefined;
  getMessage(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined;
  findReply(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined;
  unansweredClarifications(fromSessionId: string, toSessionId: string, sourceRunId: string): AgentInboxMessage[];
  pending(sessionId: string): AgentInboxMessage[];
  acknowledge(id: string): void;
  suppressWake(sessionId: string): void;
}
