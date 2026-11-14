import type { AgentInboxMessage, AgentPlan, AgentTask, AgentTaskDelegationReceipt, AgentTaskInput, PlanItem } from "../../shared/agent/coordination.js";

/** Durable coordination state. Delivery is acknowledged after transcript persistence. */
export interface AgentCoordinationRepository {
  plan(rootId: string): AgentPlan;
  updatePlan(rootId: string, revision: number, items: PlanItem[]): AgentPlan;
  tasks(rootId: string): AgentTask[];
  task(rootId: string, taskId: string): AgentTask | undefined;
  activeTask(rootId: string, ownerSessionId: string): AgentTask | undefined;
  createTask(rootId: string, draft: AgentTaskInput, dedupeKey: string): AgentTask;
  claimTask(rootId: string, taskId: string, expectedRevision: number, ownerSessionId: string, assignmentId: string, sourceRunId: string, dedupeKey: string): AgentTask;
  delegateTask(rootId: string, taskId: string, expectedRevision: number, assignmentId: string, message: AgentInboxMessage, dedupeKey: string): AgentTask;
  delegationReceipt(dedupeKey: string): AgentTaskDelegationReceipt | undefined;
  releaseTask(rootId: string, taskId: string, expectedRevision: number): AgentTask;
  completeTask(rootId: string, taskId: string, expectedRevision: number, resultRunId: string): AgentTask;
  enqueue(message: AgentInboxMessage, dedupeKey: string): string;
  messageFromToolCall(dedupeKey: string): AgentInboxMessage | undefined;
  getMessage(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined;
  findReply(id: string, fromSessionId: string, toSessionId: string): AgentInboxMessage | undefined;
  unansweredClarifications(fromSessionId: string, toSessionId: string, sourceRunId: string): AgentInboxMessage[];
  pending(sessionId: string): AgentInboxMessage[];
  acknowledge(id: string): void;
  suppressWake(sessionId: string): void;
}
