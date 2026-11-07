import type { AgentProject, AgentSession } from "../../../shared/agent/sessions.js";
import type { Project, Session } from "../../runtime/workspace-store.js";

export function toProjectJson(project: Project): AgentProject {
  const { ownerId: _ownerId, ...result } = project;
  return result;
}

export function toSessionJson(session: Session): AgentSession {
  const { ownerId: _ownerId, runs: _runs, cwd: _cwd, fileChanges: _fileChanges, ...metadata } = session;
  return metadata;
}
