import type { ReasoningEffort } from "./models.js";

export const agentProfileAccess = ["read_only", "edit"] as const;

export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly access: typeof agentProfileAccess[number];
  readonly modelTargetId?: string | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

export type AgentProfileIdentity = Pick<AgentProfile, "id" | "name" | "access">;
