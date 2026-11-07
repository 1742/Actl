import type { AgentProject, AgentSession } from "../../../../../shared/agent/sessions";
import type { AgentRuntimeKind } from "../../services/runtimeClient";

/** UI-side project identity. `id` is source-qualified; `runtimeId` is sent to the API. */
export interface RuntimeProject extends AgentProject {
  runtimeKind: AgentRuntimeKind;
  runtimeId: string;
}

/** UI-side session identity. `id` and `projectId` are source-qualified. */
export interface RuntimeSession extends Omit<AgentSession, "projectId"> {
  runtimeKind: AgentRuntimeKind;
  runtimeId: string;
  runtimeProjectId: string | null;
  projectId: string | null;
}
