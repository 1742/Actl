import type { DatabaseSync } from "node:sqlite";
import type { RuntimePromptBlock, RuntimePromptSettings } from "../../../shared/agent/prompts.js";
import { nowIso } from "../../utils.js";
import type { PromptSettingsRepository } from "../prompt-settings-repository.js";
import { withSqliteTransaction } from "./database.js";
import { numberColumn, stringColumn, type SqliteRow } from "./row.js";

export class SqlitePromptSettingsRepository implements PromptSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getPromptSettings(ownerId: string): RuntimePromptSettings | undefined {
    const row = this.db.prepare("SELECT revision, blocks_json, updated_at FROM prompt_settings WHERE owner_id = ?").get(ownerId) as SqliteRow | undefined;
    if (!row) return undefined;
    return {
      revision: numberColumn(row, "revision"),
      blocks: JSON.parse(stringColumn(row, "blocks_json")) as RuntimePromptBlock[],
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  savePromptSettings(ownerId: string, expectedRevision: number, blocks: RuntimePromptBlock[]): RuntimePromptSettings | null {
    return withSqliteTransaction(this.db, () => {
      const current = this.getPromptSettings(ownerId);
      if ((current?.revision ?? 0) !== expectedRevision) return null;
      const next: RuntimePromptSettings = { revision: expectedRevision + 1, blocks: structuredClone(blocks), updatedAt: nowIso() };
      this.db.prepare(`INSERT INTO prompt_settings(owner_id, revision, blocks_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision,
          blocks_json = excluded.blocks_json, updated_at = excluded.updated_at`)
        .run(ownerId, next.revision, JSON.stringify(next.blocks), next.updatedAt);
      return next;
    });
  }
}
