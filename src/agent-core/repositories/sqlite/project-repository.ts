import type { DatabaseSync } from "node:sqlite";
import { workspacePathKey } from "../../tools/path-security.js";
import type { ProjectRecord, ProjectRepository } from "../project-repository.js";
import { withSqliteTransaction } from "./database.js";
import { assertChanged, nullableStringColumn, numberColumn, stringColumn, type SqliteRow } from "./row.js";

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listProjects(): Promise<ProjectRecord[]> {
    const projects = this.db.prepare("SELECT id, owner_id, name, created_at, updated_at FROM projects ORDER BY created_at").all() as SqliteRow[];
    const workspaces = this.db.prepare("SELECT id, directory, is_primary FROM project_workspaces WHERE project_id = ? ORDER BY sort_order");
    return projects.map((row) => toProject(row, workspaces.all(stringColumn(row, "id")) as SqliteRow[]));
  }

  async createProject(project: ProjectRecord): Promise<void> {
    withSqliteTransaction(this.db, () => {
      this.db.prepare("INSERT INTO projects(id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(project.id, project.ownerId, project.name ?? null, project.created_at, project.updated_at);
      this.insertProjectWorkspaces(project);
    });
  }

  async updateProject(project: ProjectRecord): Promise<void> {
    withSqliteTransaction(this.db, () => {
      assertChanged(this.db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .run(project.name ?? null, project.updated_at, project.id, project.ownerId), "Project", project.id);
      this.db.prepare("DELETE FROM project_workspaces WHERE project_id = ?").run(project.id);
      this.insertProjectWorkspaces(project);
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    assertChanged(this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId), "Project", projectId);
  }

  private insertProjectWorkspaces(project: ProjectRecord): void {
    if (!project.workspaces.some((workspace) => workspace.id === project.primaryWorkspaceId)) {
      throw new Error("Project has no primary workspace.");
    }
    const insert = this.db.prepare("INSERT INTO project_workspaces(id, project_id, owner_id, directory, directory_key, sort_order, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)");
    project.workspaces.forEach((workspace, index) => {
      insert.run(workspace.id, project.id, project.ownerId, workspace.path, workspacePathKey(workspace.path),
        index, Number(workspace.id === project.primaryWorkspaceId));
    });
  }
}

function toProject(row: SqliteRow, workspaceRows: SqliteRow[]): ProjectRecord {
  const name = nullableStringColumn(row, "name");
  const workspaces = workspaceRows.map((workspace) => ({
    id: stringColumn(workspace, "id"),
    path: stringColumn(workspace, "directory"),
  }));
  const primary = workspaces[workspaceRows.findIndex((workspace) => numberColumn(workspace, "is_primary") === 1)];
  if (!primary) throw new Error("Project has no primary workspace.");
  return {
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"),
    cwd: primary.path, primaryWorkspaceId: primary.id, workspaces,
    ...(name ? { name } : {}), created_at: stringColumn(row, "created_at"), updated_at: stringColumn(row, "updated_at"),
  };
}
