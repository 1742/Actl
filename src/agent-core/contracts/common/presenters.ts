import type { AgentProject, AgentSession } from "../../../shared/agent/sessions.js";
import type { Project, Session } from "../../runtime/workspace-store.js";
import { DEFAULT_AGENT_PROFILE } from "../../runtime/multi-agents/agent-profile-catalog.js";

export function toProjectJson(project: Project): AgentProject {
  const { ownerId: _ownerId, ...result } = project;
  return result;
}

export function toSessionJson(session: Session): AgentSession {
  const { id, projectId, title, parentSessionId, rootSessionId, created_at, updated_at } = session;
  const profile = parentSessionId ? session.profile ?? DEFAULT_AGENT_PROFILE : undefined;
  return { id, projectId, ...(parentSessionId ? { parentSessionId } : {}), rootSessionId: rootSessionId ?? id,
    ...(profile ? { profile: { id: profile.id, name: profile.name } } : {}),
    ...(title === undefined ? {} : { title }), created_at, updated_at };
}
