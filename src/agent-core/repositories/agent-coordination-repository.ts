import type { AgentInboxMessage, AgentPlan, PlanItem } from "../../shared/agent/coordination.js";

/** Durable coordination state. Delivery is acknowledged after transcript persistence. */
export interface AgentCoordinationRepository {
  plan(rootId: string): AgentPlan;
  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan;
  enqueue(message: AgentInboxMessage, dedupeKey: string): boolean;
  pending(sessionId: string): AgentInboxMessage[];
  acknowledge(id: string): void;
  suppressWake(sessionId: string): void;
}
