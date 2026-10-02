import { z } from "zod";
import type { ToolCall } from "../runtime/transcript.js";
import type { ToolPermissionRequirement } from "../tools/registry.js";
import type { PermissionDecision, PermissionEngine } from "./types.js";
import { classifyShellCommand } from "./shell-command-policy.js";

export const permissionModeSchema = z.enum(["plan", "ask", "accept_edits", "full_access"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export interface RunPermissionSnapshot {
  permissionMode: PermissionMode;
}

export const runPermissionSnapshotSchema: z.ZodType<RunPermissionSnapshot> = z.object({
  permissionMode: permissionModeSchema,
}).strict();

export const DEFAULT_RUN_PERMISSION_SNAPSHOT: Readonly<RunPermissionSnapshot> = Object.freeze({
  permissionMode: "ask",
});

export class RunPermissionEngine implements PermissionEngine {
  async decide(
    toolCall: ToolCall,
    requirement: ToolPermissionRequirement,
    context: { snapshot: RunPermissionSnapshot },
  ): Promise<PermissionDecision> {
    const mode = context.snapshot.permissionMode;
    if (isReadOnly(requirement)) return { type: "allow" };
    if (mode === "full_access") return { type: "allow" };
    if (mode === "plan") {
      return { type: "deny", reason: `${requirement.capability} is disabled in plan mode.` };
    }
    if (mode === "accept_edits" && (isOrdinaryFileEdit(requirement) || isTrustedShellCommand(toolCall, requirement))) {
      return { type: "allow" };
    }
    return { type: "ask", prompt: permissionPrompt(toolCall, requirement) };
  }
}

function isReadOnly(requirement: ToolPermissionRequirement): boolean {
  return requirement.action === "read" || requirement.action === "list" ||
    requirement.capability.endsWith(".read") || requirement.capability === "filesystem.search";
}

function isOrdinaryFileEdit(requirement: ToolPermissionRequirement): boolean {
  return requirement.capability === "filesystem.write" ||
    requirement.capability === "filesystem.patch" ||
    requirement.capability === "filesystem.move";
}

function isTrustedShellCommand(toolCall: ToolCall, requirement: ToolPermissionRequirement): boolean {
  if (toolCall.name !== "shell") return false;
  if (requirement.capability !== "process.spawn") return false;
  const input = toolCall.input;
  if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") return false;
  const risk = classifyShellCommand(input.command);
  return risk === "read_only" || risk === "trusted_dev";
}

function permissionPrompt(toolCall: ToolCall, requirement: ToolPermissionRequirement): string {
  const action = requirement.action ? ` (${requirement.action})` : "";
  const resource = requirement.resource ? ` on ${requirement.resource}` : "";
  return `Allow ${toolCall.name}${action}${resource}?`;
}
