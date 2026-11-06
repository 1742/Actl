import { type ToolCall } from "../runtime/transcript.js";
import { type ToolPermissionRequirement } from "../tools/registry.js";
import type { RunPermissionSnapshot } from "./run-policy.js";

export type PermissionDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; prompt: string };

export interface PermissionContext {
  snapshot: RunPermissionSnapshot;
}

export interface PermissionEngine {
  decide(
    toolCall: ToolCall,
    requirement: ToolPermissionRequirement,
    context: PermissionContext,
  ): Promise<PermissionDecision>;
}
