import type { Request, Response } from "express";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import type { ProcessSupervisor } from "../../runtime/process/process-supervisor.js";
import type { AgentLoop } from "../../runtime/agent-loop/agent-loop.js";
import { ApiError } from "../common/api-error.js";
import { toProjectJson, toSessionJson } from "../common/presenters.js";
import { currentOwnerId } from "../../auth/runtime-auth.js";
import { validated } from "../common/validation.js";
import type { WorkspaceFileService } from "../../runtime/workspace-files.js";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import type {
  CreateProjectBody,
  ProjectParams,
  SearchProjectFilesQuery,
  ListProjectDirectoryQuery,
  UpdateProjectBody,
} from "./project.schemas.js";

export interface ProjectHandlerDependencies {
  workspaceStore: WorkspaceStore;
  processSupervisor: ProcessSupervisor;
  agentLoop: AgentLoop;
  workspaceFiles: WorkspaceFileService;
  storedFiles: StoredFileService;
}

export function createProjectHandlers({ workspaceStore, processSupervisor, agentLoop, workspaceFiles, storedFiles }: ProjectHandlerDependencies) {
  return {
    async createProject(_request: Request, response: Response): Promise<void> {
      const body = validated<CreateProjectBody>(response, "body");
      response.status(201).json(toProjectJson(await workspaceStore.createProject(currentOwnerId(response), body.cwd, body.name)));
    },

    listProjects(_request: Request, response: Response): void {
      response.json(workspaceStore.listProjects(currentOwnerId(response)).map(toProjectJson));
    },

    getProject(_request: Request, response: Response): void {
      response.json(toProjectJson(findProject(response)));
    },

    async updateProject(_request: Request, response: Response): Promise<void> {
      const { projectId } = validated<ProjectParams>(response, "params");
      const { name } = validated<UpdateProjectBody>(response, "body");
      response.json(toProjectJson(await workspaceStore.updateProject(currentOwnerId(response), projectId, name ?? undefined)));
    },

    async deleteProject(_request: Request, response: Response): Promise<void> {
      const { projectId } = validated<ProjectParams>(response, "params");
      const ownerId = currentOwnerId(response);
      findProject(response);
      await agentLoop.withProjectScopeMaintenance(projectId, async () => {
        const sessionIds = workspaceStore.listSessions(ownerId, projectId).map((session) => session.id);
        await Promise.all(sessionIds.map((sessionId) => agentLoop.cancelBySession(sessionId)));
        await Promise.all(sessionIds.map((sessionId) => processSupervisor.stopByOwner({ type: "session", id: sessionId })));
        await workspaceStore.deleteProject(ownerId, projectId);
        await storedFiles.cleanupOrphans();
      });
      response.status(204).send();
    },

    listProjectSessions(_request: Request, response: Response): void {
      const project = findProject(response);
      response.json(workspaceStore.listSessions(currentOwnerId(response), project.id).map(toSessionJson));
    },

    async searchProjectFiles(_request: Request, response: Response): Promise<void> {
      const project = findProject(response);
      const { q, limit } = validated<SearchProjectFilesQuery>(response, "query");
      response.json(await workspaceFiles.searchQuery(project.cwd, q, limit));
    },

    async listProjectDirectory(_request: Request, response: Response): Promise<void> {
      const project = findProject(response);
      const { path, maxEntries } = validated<ListProjectDirectoryQuery>(response, "query");
      response.json(await workspaceFiles.listDirectory(project.cwd, { path, maxEntries }));
    },
  };

  function findProject(response: Response) {
    const { projectId } = validated<ProjectParams>(response, "params");
    const project = workspaceStore.getProject(projectId, currentOwnerId(response));
    if (!project) throw new ApiError(404, "project_not_found", "Project not found.");
    return project;
  }
}
