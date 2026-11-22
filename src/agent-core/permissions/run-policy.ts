import { z } from "zod";
import { permissionModes, type PermissionMode } from "../../shared/agent/responses.js";
import type { ToolCall } from "../runtime/transcript.js";
import type { ToolPermissionRequirement } from "../tools/registry.js";
import type { PermissionDecision, PermissionEngine } from "./types.js";

export const permissionModeSchema = z.enum(permissionModes);
export type { PermissionMode };

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
    if (requirement.capability === 'agent.coordinate') return { type: 'allow' };
    if (toolCall.name === "shell" && requirement.capability === "process.spawn.readonly") return { type: "allow" };
    if (toolCall.name === "shell_stop" && requirement.capability === "process.terminate.sandboxed") return { type: "allow" };
    if (isReadOnly(requirement)) return { type: "allow" };
    if (mode === "full_access") return { type: "allow" };
    if (mode === "plan") {
      return { type: "deny", reason: `${requirement.capability} is disabled in plan mode.` };
    }
    if (mode === "accept_edits" && (isOrdinaryFileEdit(requirement) ||
      (toolCall.name === "shell" && requirement.capability === "process.spawn.workspace"))) {
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

function permissionPrompt(toolCall: ToolCall, requirement: ToolPermissionRequirement): string {
  const action = requirement.action ? ` (${requirement.action})` : "";
  const resource = requirement.resource ? ` on ${requirement.resource}` : "";
  return `Allow ${toolCall.name}${action}${resource}?`;
}
