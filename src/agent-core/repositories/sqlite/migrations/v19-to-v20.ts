import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { workspaceDirectoryName, workspacePathKey } from "../../../tools/path-security.js";
import { parseSqliteMessage } from "../run-payload-codec.js";

export function migrateProjectWorkspaces(database: DatabaseSync): void {
  database.exec(`
    CREATE UNIQUE INDEX projects_id_owner_idx ON projects(id, owner_id);
    CREATE TABLE project_workspaces(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      directory TEXT NOT NULL, directory_key TEXT NOT NULL,
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0), is_primary INTEGER NOT NULL CHECK(is_primary IN (0, 1)),
      FOREIGN KEY(project_id, owner_id) REFERENCES projects(id, owner_id) ON DELETE CASCADE,
      UNIQUE(owner_id, directory_key), UNIQUE(project_id, sort_order)
    ) STRICT;
    CREATE UNIQUE INDEX project_workspaces_primary_idx ON project_workspaces(project_id) WHERE is_primary = 1;
  `);
  const insertWorkspace = database.prepare(`
    INSERT INTO project_workspaces(id, project_id, owner_id, directory, directory_key, sort_order, is_primary)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `);
  const nameProject = database.prepare("UPDATE projects SET name = ? WHERE id = ? AND name IS NULL");
  const projects = database.prepare("SELECT id, owner_id, cwd FROM projects").all() as Array<{
    id: string; owner_id: string; cwd: string;
  }>;
  for (const { id, owner_id, cwd } of projects) {
    insertWorkspace.run(`workspace:${id}`, id, owner_id, cwd, workspacePathKey(cwd));
    nameProject.run(workspaceDirectoryName(cwd), id);
  }

  const updateMessage = database.prepare("UPDATE run_messages SET payload_json = ? WHERE run_id = ? AND message_order = ?");
  const messages = database.prepare(`
    SELECT m.run_id, m.message_order, m.payload_json, p.cwd FROM run_messages m
    JOIN agent_runs r ON r.id = m.run_id JOIN sessions s ON s.id = r.session_id JOIN projects p ON p.id = s.project_id
    WHERE EXISTS (SELECT 1 FROM json_each(m.payload_json, '$.content') WHERE json_extract(value, '$.type') = 'workspace_file')
  `).all() as Array<{ run_id: string; message_order: number; payload_json: string; cwd: string }>;
  for (const row of messages) {
    const message = parseSqliteMessage(row.payload_json);
    for (const part of message.content) {
      if (part.type === "workspace_file") part.path = path.resolve(row.cwd, part.path).split(path.sep).join("/");
    }
    updateMessage.run(JSON.stringify(message), row.run_id, row.message_order);
  }

  const updateChange = database.prepare("UPDATE file_changes SET file_path = ? WHERE id = ?");
  const changes = database.prepare(`
    SELECT f.id, f.file_path, p.cwd FROM file_changes f
    JOIN sessions s ON s.id = f.session_id JOIN projects p ON p.id = s.project_id
  `).all() as Array<{ id: string; file_path: string; cwd: string }>;
  for (const row of changes) updateChange.run(path.resolve(row.cwd, row.file_path), row.id);

  database.exec("DROP INDEX projects_owner_cwd_idx; ALTER TABLE projects DROP COLUMN cwd;");
}
