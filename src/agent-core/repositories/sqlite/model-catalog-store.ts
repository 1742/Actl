import type { DatabaseSync } from "node:sqlite";
import type { ProviderAccountRecord, ModelTargetRecord } from "../../model/catalog-types.js";
import type { EncryptedSecret } from "../../security/encrypted-secret.js";
import { reasoningEffortSchema } from "../../model/catalog-types.js";
import type { CreateProviderAccountRecord, ModelCatalogRepository, ModelPreferenceRecord } from "../model-catalog-repository.js";
import {
  assertChanged, bufferColumn, nullableStringColumn, numberColumn, type SqliteRow,
  toProviderAccount, toModelTarget,
} from "./row-codec.js";

export class SqliteModelCatalogStore implements ModelCatalogRepository {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  listProviderAccounts(ownerId: string): ProviderAccountRecord[] {
    return (this.db.prepare(`SELECT a.*, v.base_url, v.credential_version FROM provider_accounts a
      JOIN provider_account_versions v ON v.account_id = a.id AND v.version = a.current_version
      WHERE a.owner_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at`).all(ownerId) as SqliteRow[]).map(toProviderAccount);
  }

  getProviderAccount(ownerId: string, accountId: string): ProviderAccountRecord | undefined {
    const row = this.db.prepare(`SELECT a.*, v.base_url, v.credential_version FROM provider_accounts a
      JOIN provider_account_versions v ON v.account_id = a.id AND v.version = a.current_version
      WHERE a.owner_id = ? AND a.id = ? AND a.deleted_at IS NULL`).get(ownerId, accountId) as SqliteRow | undefined;
    return row ? toProviderAccount(row) : undefined;
  }

  getProviderAccountVersion(ownerId: string, accountId: string, version: number): ProviderAccountRecord | undefined {
    const row = this.db.prepare(`SELECT a.*, v.version AS current_version, v.base_url, v.credential_version
      FROM provider_accounts a JOIN provider_account_versions v ON v.account_id = a.id
      WHERE a.owner_id = ? AND a.id = ? AND v.version = ?`).get(ownerId, accountId, version) as SqliteRow | undefined;
    return row ? toProviderAccount(row) : undefined;
  }

  async createProviderAccount({ account, credential }: CreateProviderAccountRecord): Promise<void> {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO provider_accounts(
        id, owner_id, display_name, enabled, current_version, deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`).run(account.id, account.ownerId, account.displayName,
        account.enabled ? 1 : 0, account.currentVersion, account.createdAt, account.updatedAt);
      this.insertCredential(account.id, account.credentialVersion ?? 1, credential, account.createdAt);
      this.insertAccountVersion(account);
    });
  }

  async updateProviderAccount(account: ProviderAccountRecord): Promise<void> {
    this.transaction(() => {
      this.insertAccountVersion(account);
      assertChanged(this.db.prepare(`UPDATE provider_accounts SET display_name = ?, enabled = ?,
        current_version = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`).run(
        account.displayName, account.enabled ? 1 : 0, account.currentVersion, account.updatedAt,
        account.id, account.ownerId), "Provider account", account.id);
    });
  }

  async replaceProviderCredential(account: ProviderAccountRecord, credential: EncryptedSecret): Promise<void> {
    this.transaction(() => {
      this.insertCredential(account.id, account.credentialVersion ?? 1, credential, account.updatedAt);
      this.insertAccountVersion(account);
      assertChanged(this.db.prepare(`UPDATE provider_accounts SET current_version = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`).run(
        account.currentVersion, account.updatedAt, account.id, account.ownerId), "Provider account", account.id);
    });
  }

  async clearProviderCredential(account: ProviderAccountRecord): Promise<void> {
    this.transaction(() => {
      this.db.prepare("DELETE FROM provider_credentials WHERE account_id = ?").run(account.id);
      this.insertAccountVersion(account);
      assertChanged(this.db.prepare(`UPDATE provider_accounts SET current_version = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`).run(
        account.currentVersion, account.updatedAt, account.id, account.ownerId), "Provider account", account.id);
    });
  }

  async deleteProviderAccount(ownerId: string, accountId: string, deletedAt: string): Promise<void> {
    this.transaction(() => {
      assertChanged(this.db.prepare(`UPDATE provider_accounts SET enabled = 0, deleted_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`).run(deletedAt, deletedAt, accountId, ownerId), "Provider account", accountId);
      this.db.prepare("DELETE FROM provider_credentials WHERE account_id = ?").run(accountId);
      this.db.prepare("DELETE FROM user_model_targets WHERE account_id = ? AND owner_id = ?").run(accountId, ownerId);
    });
  }

  readCredential(accountId: string, version: number): EncryptedSecret | undefined {
    const row = this.db.prepare(`SELECT ciphertext, nonce, auth_tag, key_version FROM provider_credentials
      WHERE account_id = ? AND version = ?`).get(accountId, version) as SqliteRow | undefined;
    return row ? {
      ciphertext: bufferColumn(row, "ciphertext"), nonce: bufferColumn(row, "nonce"),
      authTag: bufferColumn(row, "auth_tag"), keyVersion: numberColumn(row, "key_version"),
    } : undefined;
  }

  listUserModelTargets(ownerId: string): ModelTargetRecord[] {
    return (this.db.prepare("SELECT * FROM user_model_targets WHERE owner_id = ? ORDER BY created_at").all(ownerId) as SqliteRow[]).map(toModelTarget);
  }

  getUserModelTarget(ownerId: string, targetId: string): ModelTargetRecord | undefined {
    const row = this.db.prepare("SELECT * FROM user_model_targets WHERE owner_id = ? AND id = ?").get(ownerId, targetId) as SqliteRow | undefined;
    return row ? toModelTarget(row) : undefined;
  }

  async createUserModelTarget(target: ModelTargetRecord): Promise<void> {
    this.db.prepare(`INSERT INTO user_model_targets(
      id, owner_id, account_id, provider_model, display_name, protocol, capabilities_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(target.id, target.ownerId, target.accountId, target.providerModel,
      target.displayName, target.protocol, JSON.stringify(target.capabilities), target.enabled ? 1 : 0, target.createdAt, target.updatedAt);
  }

  async updateUserModelTarget(target: ModelTargetRecord): Promise<void> {
    assertChanged(this.db.prepare(`UPDATE user_model_targets SET provider_model = ?, display_name = ?, protocol = ?,
      capabilities_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND owner_id = ?`).run(target.providerModel,
      target.displayName, target.protocol, JSON.stringify(target.capabilities), target.enabled ? 1 : 0,
      target.updatedAt, target.id, target.ownerId), "Model target", target.id);
  }

  async deleteUserModelTarget(ownerId: string, targetId: string): Promise<void> {
    assertChanged(this.db.prepare("DELETE FROM user_model_targets WHERE id = ? AND owner_id = ?").run(targetId, ownerId), "Model target", targetId);
  }

  getModelPreference(ownerId: string): ModelPreferenceRecord | undefined {
    const row = this.db.prepare("SELECT selected_model_target_id, reasoning_effort FROM user_model_preferences WHERE owner_id = ?").get(ownerId) as SqliteRow | undefined;
    if (!row) return undefined;
    const modelTargetId = nullableStringColumn(row, "selected_model_target_id");
    const reasoningEffort = nullableStringColumn(row, "reasoning_effort");
    return { ...(modelTargetId ? { modelTargetId } : {}), ...(reasoningEffort ? { reasoningEffort: reasoningEffortSchema.parse(reasoningEffort) } : {}) };
  }

  async setModelPreference(ownerId: string, preference: ModelPreferenceRecord, updatedAt: string): Promise<void> {
    this.db.prepare(`INSERT INTO user_model_preferences(owner_id, selected_model_target_id, reasoning_effort, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET selected_model_target_id = excluded.selected_model_target_id,
      reasoning_effort = excluded.reasoning_effort, updated_at = excluded.updated_at`).run(
      ownerId, preference.modelTargetId ?? null, preference.reasoningEffort ?? null, updatedAt);
  }

  private insertAccountVersion(account: ProviderAccountRecord): void {
    this.db.prepare(`INSERT INTO provider_account_versions(account_id, version, base_url, config_json, credential_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(account.id, account.currentVersion, account.baseURL, "{}", account.credentialVersion, account.updatedAt);
  }

  private insertCredential(accountId: string, version: number, credential: EncryptedSecret, createdAt: string): void {
    this.db.prepare(`INSERT INTO provider_credentials(account_id, version, ciphertext, nonce, auth_tag, key_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(accountId, version, credential.ciphertext, credential.nonce, credential.authTag, credential.keyVersion, createdAt);
  }
}
