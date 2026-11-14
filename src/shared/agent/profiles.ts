import type { ReasoningEffort } from "./models.js";

export interface AgentProfile {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly modelTargetId?: string | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

export type AgentProfileIdentity = Pick<AgentProfile, "id" | "name">;
