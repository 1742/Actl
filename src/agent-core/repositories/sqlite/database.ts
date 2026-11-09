import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runSqliteMigrations } from "./migrations/index.js";
import { initializeWorkspaceSchema, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from "./initial-schema.js";

export class WorkspaceSchemaIncompatibleError extends Error {
  readonly code = "workspace_schema_incompatible";

  constructor() {
    super("Workspace database schema is incompatible. Archive the existing data directory and start with an empty one.");
    this.name = "WorkspaceSchemaIncompatibleError";
  }
}

export async function openWorkspaceDatabase(databasePath: string): Promise<DatabaseSync> {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const existed = existsSync(databasePath);
  const db = new DatabaseSync(databasePath, { timeout: 5_000 });
  try {
    if (existed) {
      runSqliteMigrations(db, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new WorkspaceSchemaIncompatibleError());
    }
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    if (!existed) {
      withSqliteTransaction(db, () => initializeWorkspaceSchema(db));
    }
    return db;
  } catch (error) {
    db.close();
    if (error instanceof WorkspaceSchemaIncompatibleError) throw error;
    throw new WorkspaceSchemaIncompatibleError();
  }
}

export function withSqliteTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
