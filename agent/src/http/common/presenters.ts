import type { Project, Session } from "../../runtime/workspace-store.js";

export function toProjectJson(project: Project) {
  const { ownerId: _ownerId, ...result } = project;
  return result;
}

export function toSessionJson(session: Session) {
  const { ownerId: _ownerId, runs: _runs, cwd: _cwd, fileChanges: _fileChanges, ...metadata } = session;
  return metadata;
}
