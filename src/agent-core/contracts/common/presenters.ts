import type { AgentProject, AgentSession } from "../../../shared/agent/sessions.js";
import type { Project, Session } from "../../runtime/workspace-store.js";

export function toProjectJson(project: Project): AgentProject {
  const { ownerId: _ownerId, ...result } = project;
  return result;
}

export function toSessionJson(session: Session): AgentSession {
  const { id, projectId, title, parentSessionId, rootSessionId, created_at, updated_at } = session;
  const metadata = { id, projectId, ...(parentSessionId ? { parentSessionId } : {}), rootSessionId: rootSessionId ?? id, ...(title === undefined ? {} : { title }), created_at, updated_at };
  return metadata;
}
