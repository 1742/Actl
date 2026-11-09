import type { AgentProject } from "../../shared/agent/sessions.js";

export interface ProjectRecord extends AgentProject {
  ownerId: string;
}

export interface ProjectRepository {
  listProjects(): Promise<ProjectRecord[]>;
  createProject(project: ProjectRecord): Promise<void>;
  updateProject(project: ProjectRecord): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}
