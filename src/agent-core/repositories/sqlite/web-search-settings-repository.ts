import type { DatabaseSync } from "node:sqlite";
import type { WebSearchSettingsRecord, WebSearchSettingsRepository } from "../web-search-settings-repository.js";
import { bufferColumn, nullableNumberColumn, numberColumn, stringColumn, type SqliteRow } from "./row.js";

export class SqliteWebSearchSettingsRepository implements WebSearchSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getWebSearchSettings(ownerId: string): WebSearchSettingsRecord | undefined {
    const row = this.db.prepare("SELECT * FROM web_search_settings WHERE owner_id = ?").get(ownerId) as SqliteRow | undefined;
    if (!row) return undefined;
    const keyVersion = nullableNumberColumn(row, "key_version");
    const credential = keyVersion !== null
      ? {
          ciphertext: bufferColumn(row, "ciphertext"),
          nonce: bufferColumn(row, "nonce"),
          authTag: bufferColumn(row, "auth_tag"),
          keyVersion,
        }
      : undefined;
    return {
      ownerId: stringColumn(row, "owner_id"),
      provider: stringColumn(row, "provider") as WebSearchSettingsRecord["provider"],
      mode: stringColumn(row, "mode") as WebSearchSettingsRecord["mode"],
      enabled: numberColumn(row, "enabled") === 1,
      baseUrl: stringColumn(row, "base_url"),
      ...(credential ? { credential } : {}),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  async upsertWebSearchSettings(record: WebSearchSettingsRecord): Promise<void> {
    const credential = record.credential;
    this.db.prepare(`INSERT INTO web_search_settings(
      owner_id, provider, mode, enabled, base_url, ciphertext, nonce, auth_tag, key_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET provider = excluded.provider, mode = excluded.mode, enabled = excluded.enabled,
      base_url = excluded.base_url, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
      auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = excluded.updated_at`
    ).run(
      record.ownerId, record.provider, record.mode, record.enabled ? 1 : 0, record.baseUrl,
      credential?.ciphertext ?? null, credential?.nonce ?? null, credential?.authTag ?? null,
      credential?.keyVersion ?? null, record.updatedAt,
    );
  }

  async clearWebSearchCredential(ownerId: string, updatedAt: string): Promise<void> {
    this.db.prepare(`UPDATE web_search_settings SET enabled = CASE WHEN mode = 'external' THEN 0 ELSE enabled END, ciphertext = NULL, nonce = NULL,
      auth_tag = NULL, key_version = NULL, updated_at = ? WHERE owner_id = ?`).run(updatedAt, ownerId);
  }
}
