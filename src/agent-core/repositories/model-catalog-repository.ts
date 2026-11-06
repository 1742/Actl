import type {
  ProviderAccountRecord,
  ReasoningEffort,
  ModelTargetRecord,
} from "../model/catalog-types.js";
import type { EncryptedSecret } from "../security/encrypted-secret.js";

export interface CreateProviderAccountRecord {
  account: ProviderAccountRecord;
  credential: EncryptedSecret;
}

export interface ModelPreferenceRecord {
  modelTargetId?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelCatalogRepository {
  listProviderAccounts(ownerId: string): ProviderAccountRecord[];
  getProviderAccount(ownerId: string, accountId: string): ProviderAccountRecord | undefined;
  getProviderAccountVersion(ownerId: string, accountId: string, version: number): ProviderAccountRecord | undefined;
  createProviderAccount(record: CreateProviderAccountRecord): Promise<void>;
  updateProviderAccount(account: ProviderAccountRecord): Promise<void>;
  replaceProviderCredential(account: ProviderAccountRecord, credential: EncryptedSecret): Promise<void>;
  clearProviderCredential(account: ProviderAccountRecord): Promise<void>;
  deleteProviderAccount(ownerId: string, accountId: string, deletedAt: string): Promise<void>;
  readCredential(accountId: string, version: number): EncryptedSecret | undefined;
  listUserModelTargets(ownerId: string): ModelTargetRecord[];
  getUserModelTarget(ownerId: string, targetId: string): ModelTargetRecord | undefined;
  createUserModelTarget(target: ModelTargetRecord): Promise<void>;
  updateUserModelTarget(target: ModelTargetRecord): Promise<void>;
  deleteUserModelTarget(ownerId: string, targetId: string): Promise<void>;
  getModelPreference(ownerId: string): ModelPreferenceRecord | undefined;
  setModelPreference(ownerId: string, preference: ModelPreferenceRecord, updatedAt: string): Promise<void>;
}
