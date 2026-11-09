import type { DatabaseSync } from "node:sqlite";
import type { StoredFileRecord, StoredFileRepository } from "../stored-file-repository.js";
import { numberColumn, stringColumn, type SqliteRow } from "./row.js";

export class SqliteStoredFileRepository implements StoredFileRepository {
  constructor(private readonly db: DatabaseSync) {}

  async createStoredFile(file: StoredFileRecord): Promise<void> {
    this.db.prepare(`INSERT INTO stored_files(id, session_id, filename, media_type, byte_size, sha256, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      file.id, file.sessionId, file.filename, file.mediaType, file.size, file.sha256, file.storageKey, file.createdAt,
    );
  }

  getStoredFile(fileId: string): StoredFileRecord | undefined {
    const row = this.db.prepare("SELECT * FROM stored_files WHERE id = ?").get(fileId) as SqliteRow | undefined;
    return row ? toStoredFile(row) : undefined;
  }

  listStoredFiles(sessionId: string): StoredFileRecord[] {
    return (this.db.prepare("SELECT * FROM stored_files WHERE session_id = ? ORDER BY created_at").all(sessionId) as SqliteRow[]).map(toStoredFile);
  }

  async deleteExpiredUnboundFiles(olderThan: string): Promise<void> {
    this.db.prepare(`DELETE FROM stored_files WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM file_bindings b WHERE b.file_id = stored_files.id)`).run(olderThan);
  }

  listReferencedStorageKeys(): string[] {
    return (this.db.prepare("SELECT DISTINCT storage_key FROM stored_files").all() as SqliteRow[])
      .map((row) => stringColumn(row, "storage_key"));
  }
}

function toStoredFile(row: SqliteRow): StoredFileRecord {
  return {
    id: stringColumn(row, "id"), sessionId: stringColumn(row, "session_id"), filename: stringColumn(row, "filename"),
    mediaType: stringColumn(row, "media_type"), size: numberColumn(row, "byte_size"), sha256: stringColumn(row, "sha256"),
    storageKey: stringColumn(row, "storage_key"), createdAt: stringColumn(row, "created_at"),
  };
}
