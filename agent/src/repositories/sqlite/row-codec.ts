import type {
  ProviderAccountRecord,
  ModelTargetRecord,
} from "../../model/catalog-types.js";
import {
  modelCapabilitiesSchema,
  modelExecutionSnapshotSchema,
  modelProtocolSchema,
} from "../../model/catalog-types.js";
import type {
  FileChangeRecord,
  ProjectRecord,
  SessionMetadataRecord,
  StoredFileRecord,
} from "../workspace-repository.js";
import { runPermissionSnapshotSchema } from "../../permissions/engine.js";

export type SqliteRow = Record<string, unknown>;

export function toProject(row: SqliteRow): ProjectRecord {
  const name = nullableStringColumn(row, "name");
  return {
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"), cwd: stringColumn(row, "cwd"),
    ...(name ? { name } : {}), created_at: stringColumn(row, "created_at"), updated_at: stringColumn(row, "updated_at"),
  };
}

export function toSessionMetadata(row: SqliteRow): SessionMetadataRecord {
  const title = nullableStringColumn(row, "title");
  return {
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"), projectId: nullableStringColumn(row, "project_id"),
    ...(title ? { title } : {}), created_at: stringColumn(row, "created_at"), updated_at: stringColumn(row, "updated_at"),
  };
}

export function toFileChange(row: SqliteRow): FileChangeRecord {
  const diff = nullableStringColumn(row, "diff");
  const newContent = nullableStringColumn(row, "new_content");
  const oldContent = nullableStringColumn(row, "old_content");
  return {
    id: stringColumn(row, "id"), sessionId: stringColumn(row, "session_id"), filePath: stringColumn(row, "file_path"),
    changeType: stringColumn(row, "change_type") as FileChangeRecord["changeType"], summary: stringColumn(row, "summary"),
    ...(diff === null ? {} : { diff }), ...(newContent === null ? {} : { newContent }),
    ...(oldContent === null ? {} : { oldContent }), created_at: stringColumn(row, "created_at"),
  };
}

export function toStoredFile(row: SqliteRow): StoredFileRecord {
  return {
    id: stringColumn(row, "id"), sessionId: stringColumn(row, "session_id"), filename: stringColumn(row, "filename"),
    mediaType: stringColumn(row, "media_type"), size: numberColumn(row, "byte_size"), sha256: stringColumn(row, "sha256"),
    storageKey: stringColumn(row, "storage_key"), createdAt: stringColumn(row, "created_at"),
  };
}

export function toProviderAccount(row: SqliteRow): ProviderAccountRecord {
  return {
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"),
    displayName: stringColumn(row, "display_name"), enabled: numberColumn(row, "enabled") === 1,
    currentVersion: numberColumn(row, "current_version"), baseURL: nullableStringColumn(row, "base_url") ?? "",
    credentialVersion: nullableNumberColumn(row, "credential_version"), deletedAt: nullableStringColumn(row, "deleted_at"),
    createdAt: stringColumn(row, "created_at"), updatedAt: stringColumn(row, "updated_at"),
  };
}


export function toModelTarget(row: SqliteRow): ModelTargetRecord {
  let decoded: unknown;
  try { decoded = JSON.parse(stringColumn(row, "capabilities_json")); }
  catch { throw new Error("Stored model capabilities contain invalid JSON."); }
  return {
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"), accountId: stringColumn(row, "account_id"),
    providerModel: stringColumn(row, "provider_model"), displayName: stringColumn(row, "display_name"),
    protocol: modelProtocolSchema.parse(stringColumn(row, "protocol")), capabilities: modelCapabilitiesSchema.parse(decoded),
    enabled: numberColumn(row, "enabled") === 1, createdAt: stringColumn(row, "created_at"), updatedAt: stringColumn(row, "updated_at"),
  };
}

export function parseModelSnapshot(json: string) {
  let decoded: unknown;
  try { decoded = JSON.parse(json); }
  catch { throw new Error("Stored model snapshot contains invalid JSON."); }
  return modelExecutionSnapshotSchema.parse(decoded);
}

export function parsePermissionSnapshot(json: string) {
  let decoded: unknown;
  try { decoded = JSON.parse(json); }
  catch { throw new Error("Stored permission snapshot contains invalid JSON."); }
  return runPermissionSnapshotSchema.parse(decoded);
}

export function stringColumn(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not text.`);
  return value;
}

export function nullableStringColumn(row: SqliteRow, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not nullable text.`);
  return value;
}

export function numberColumn(row: SqliteRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number") throw new Error(`SQLite column ${name} is not numeric.`);
  return value;
}

export function nullableNumberColumn(row: SqliteRow, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`SQLite column ${name} is not nullable numeric.`);
  return value;
}

export function bufferColumn(row: SqliteRow, name: string): Buffer {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new Error(`SQLite column ${name} is not a blob.`);
  return Buffer.from(value);
}

export function assertChanged(result: { changes: number | bigint }, entity: string, id: string): void {
  if (result.changes === 0 || result.changes === 0n) throw new Error(`${entity} not found: ${id}`);
}
