import type { RuntimeMode } from "../app/config.js";
import type {
  ModelCapabilities,
  ModelExecutionSnapshot,
  ModelProtocolConfig,
  ModelTargetDto,
  ProviderAccountRecord,
  ReasoningEffort,
  ModelTargetRecord,
} from "../model/catalog-types.js";
import { modelCapabilitiesSchema, modelProtocolSchema, TEXT_TOOL_CAPABILITIES } from "../model/catalog-types.js";
import type { ModelClient } from "../model/client.js";
import { createModelClient } from "../model/client-factory.js";
import type { ModelCatalogRepository } from "../repositories/model-catalog-repository.js";
import type { SecretProtector } from "../security/secret-protector.js";
import { createRandomId, nowIso } from "../utils.js";

export type ModelStoreErrorCode =
  | "model_target_not_found"
  | "model_target_disabled"
  | "provider_account_not_found"
  | "provider_credential_missing"
  | "reasoning_effort_invalid";

export class ModelStoreError extends Error {
  constructor(
    readonly code: ModelStoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelCatalogResult {
  data: ModelTargetDto[];
  selectedModelTargetId?: string;
  selectedReasoningEffort?: ReasoningEffort;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface ProviderAccountView {
  id: string;
  displayName: string;
  baseURL: string;
  enabled: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderAccountInput {
  displayName: string;
  baseURL: string;
  apiKey: string;
}

export class ModelStore {
  constructor(
    private readonly repository: ModelCatalogRepository,
    private readonly credentials: SecretProtector,
    readonly mode: RuntimeMode,
  ) {}

  async list(ownerId: string): Promise<ModelCatalogResult> {
    const data = this.repository.listUserModelTargets(ownerId).flatMap((target) => {
      const account = this.repository.getProviderAccount(ownerId, target.accountId);
      return account ? [toDto(target, account)] : [];
    });
    const preferred = this.repository.getModelPreference(ownerId);
    const selected =
      preferred?.modelTargetId && data.some((item) => item.id === preferred.modelTargetId && item.enabled)
        ? preferred.modelTargetId
        : undefined;
    const selectedModelTargetId = selected ?? data.find((item) => item.enabled)?.id;
    const selectedModel = data.find(({ id }) => id === selectedModelTargetId);
    const selectedReasoningEffort = selectedModel
      ? validReasoningEffort(
          selectedModel.capabilities,
          selected === selectedModelTargetId ? preferred?.reasoningEffort : undefined,
        ) ?? selectedModel.capabilities.defaultReasoningEffort
      : undefined;
    return {
      data,
      ...(selectedModelTargetId ? { selectedModelTargetId } : {}),
      ...(selectedReasoningEffort ? { selectedReasoningEffort } : {}),
      diagnostics: [],
    };
  }

  listProviderAccounts(ownerId: string): ProviderAccountView[] {
    return this.repository.listProviderAccounts(ownerId).map((account) => ({
      id: account.id,
      displayName: account.displayName,
      baseURL: account.baseURL,
      enabled: account.enabled,
      hasCredential: account.credentialVersion !== null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    }));
  }

  async createProviderAccount(ownerId: string, input: CreateProviderAccountInput): Promise<ProviderAccountRecord> {
    const now = nowIso();
    const account: ProviderAccountRecord = {
      id: createRandomId("provider"),
      ownerId,
      displayName: input.displayName,
      enabled: true,
      currentVersion: 1,
      baseURL: normalizeBaseUrl(input.baseURL),
      credentialVersion: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createProviderAccount({ account, credential: this.credentials.encrypt(input.apiKey) });
    return account;
  }

  async updateProviderAccount(
    ownerId: string,
    accountId: string,
    updates: Partial<Pick<ProviderAccountRecord, "displayName" | "baseURL" | "enabled">>,
  ): Promise<ProviderAccountRecord> {
    const current = this.requireAccount(ownerId, accountId);
    const account: ProviderAccountRecord = {
      ...current,
      ...updates,
      ...(updates.baseURL ? { baseURL: normalizeBaseUrl(updates.baseURL) } : {}),
      currentVersion: current.currentVersion + 1,
      updatedAt: nowIso(),
    };
    await this.repository.updateProviderAccount(account);
    return account;
  }

  async replaceCredential(ownerId: string, accountId: string, apiKey: string): Promise<void> {
    const current = this.requireAccount(ownerId, accountId);
    await this.repository.replaceProviderCredential(
      {
        ...current,
        currentVersion: current.currentVersion + 1,
        credentialVersion: (current.credentialVersion ?? 0) + 1,
        updatedAt: nowIso(),
      },
      this.credentials.encrypt(apiKey),
    );
  }

  async clearCredential(ownerId: string, accountId: string): Promise<void> {
    const current = this.requireAccount(ownerId, accountId);
    await this.repository.clearProviderCredential({
      ...current,
      currentVersion: current.currentVersion + 1,
      credentialVersion: null,
      updatedAt: nowIso(),
    });
  }

  async deleteProviderAccount(ownerId: string, accountId: string): Promise<void> {
    this.requireAccount(ownerId, accountId);
    await this.repository.deleteProviderAccount(ownerId, accountId, nowIso());
  }

  async createModelTarget(
    ownerId: string,
    accountId: string,
    input: {
      providerModel: string;
      displayName: string;
      protocol: ModelProtocolConfig;
      capabilities: ModelCapabilities;
    },
  ): Promise<ModelTargetRecord> {
    this.requireAccount(ownerId, accountId);
    const now = nowIso();
    const target: ModelTargetRecord = {
      id: createRandomId("model"),
      ownerId,
      accountId,
      providerModel: input.providerModel,
      displayName: input.displayName,
      protocol: modelProtocolSchema.parse(input.protocol),
      capabilities: normalizeCapabilities(input.capabilities),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.createUserModelTarget(target);
    return target;
  }

  async updateModelTarget(
    ownerId: string,
    targetId: string,
    updates: Partial<Pick<ModelTargetRecord, "providerModel" | "displayName" | "protocol" | "capabilities" | "enabled">>,
  ): Promise<ModelTargetRecord> {
    const current = this.repository.getUserModelTarget(ownerId, targetId);
    if (!current) throw new ModelStoreError("model_target_not_found", "Model target not found.");
    this.requireAccount(ownerId, current.accountId);
    const target: ModelTargetRecord = {
      ...current,
      ...updates,
      ...(updates.protocol ? { protocol: modelProtocolSchema.parse(updates.protocol) } : {}),
      ...(updates.capabilities ? { capabilities: normalizeCapabilities(updates.capabilities) } : {}),
      updatedAt: nowIso(),
    };
    await this.repository.updateUserModelTarget(target);
    return target;
  }

  async deleteModelTarget(ownerId: string, targetId: string): Promise<void> {
    if (!this.repository.getUserModelTarget(ownerId, targetId)) {
      throw new ModelStoreError("model_target_not_found", "Model target not found.");
    }
    await this.repository.deleteUserModelTarget(ownerId, targetId);
  }

  async setPreference(ownerId: string, targetId: string | undefined, reasoningEffort?: ReasoningEffort): Promise<void> {
    if (targetId) {
      const target = (await this.list(ownerId)).data.find((item) => item.id === targetId && item.enabled);
      if (!target) throw new ModelStoreError("model_target_not_found", "Model target not found.");
      if (reasoningEffort && !target.capabilities.reasoningEfforts.includes(reasoningEffort)) {
        throw new ModelStoreError("reasoning_effort_invalid", "Reasoning effort is not supported by this model.");
      }
    }
    await this.repository.setModelPreference(
      ownerId,
      { ...(targetId ? { modelTargetId: targetId } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) },
      nowIso(),
    );
  }

  async resolveSnapshot(
    ownerId: string,
    targetId: string,
    requestedEffort?: ReasoningEffort,
  ): Promise<ModelExecutionSnapshot> {
    const target = this.repository.getUserModelTarget(ownerId, targetId);
    if (!target) throw new ModelStoreError("model_target_not_found", "Model target not found.");
    const account = this.requireAccount(ownerId, target.accountId);
    if (!target.enabled || !account.enabled) {
      throw new ModelStoreError("model_target_disabled", "Model target is disabled.");
    }
    if (!account.credentialVersion) {
      throw new ModelStoreError("provider_credential_missing", "Provider credential is missing.");
    }
    const preference = this.repository.getModelPreference(ownerId);
    const reasoningEffort =
      requestedEffort ??
      (preference?.modelTargetId === targetId ? preference.reasoningEffort : undefined) ??
      target.capabilities.defaultReasoningEffort;
    if (reasoningEffort && !target.capabilities.reasoningEfforts.includes(reasoningEffort)) {
      throw new ModelStoreError("reasoning_effort_invalid", "Reasoning effort is not supported by this model.");
    }
    return {
      targetId,
      displayName: target.displayName,
      providerModel: target.providerModel,
      accountId: account.id,
      accountVersion: account.currentVersion,
      credentialVersion: account.credentialVersion,
      baseURL: account.baseURL,
      protocol: target.protocol,
      capabilities: structuredClone(target.capabilities),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }

  async getClientForSnapshot(ownerId: string, snapshot: ModelExecutionSnapshot): Promise<ModelClient> {
    const account = this.repository.getProviderAccountVersion(ownerId, snapshot.accountId, snapshot.accountVersion);
    if (!account) throw new ModelStoreError("provider_account_not_found", "Provider account version not found.");
    const envelope = this.repository.readCredential(account.id, snapshot.credentialVersion);
    if (!envelope) throw new ModelStoreError("provider_credential_missing", "Provider credential is missing.");
    return createModelClient({
      model: snapshot.providerModel,
      baseURL: snapshot.baseURL,
      apiKey: this.credentials.decrypt(envelope),
      protocol: snapshot.protocol,
    });
  }

  private requireAccount(ownerId: string, accountId: string): ProviderAccountRecord {
    const account = this.repository.getProviderAccount(ownerId, accountId);
    if (!account) throw new ModelStoreError("provider_account_not_found", "Provider account not found.");
    return account;
  }
}

function toDto(target: ModelTargetRecord, account: ProviderAccountRecord): ModelTargetDto {
  return {
    id: target.id,
    providerAccountId: account.id,
    providerModel: target.providerModel,
    protocol: target.protocol,
    displayName: target.displayName,
    enabled: target.enabled && account.enabled,
    capabilities: target.capabilities,
  };
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function normalizeCapabilities(value: ModelCapabilities): ModelCapabilities {
  const capabilities = modelCapabilitiesSchema.parse(value);
  const defaultReasoningEffort =
    capabilities.defaultReasoningEffort && capabilities.reasoningEfforts.includes(capabilities.defaultReasoningEffort)
      ? capabilities.defaultReasoningEffort
      : undefined;
  return {
    ...capabilities,
    nativeWebSearch: capabilities.toolCalling && capabilities.nativeWebSearch,
    parallelToolCalls: capabilities.toolCalling && capabilities.parallelToolCalls,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

function validReasoningEffort(
  capabilities: ModelCapabilities,
  effort: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return effort && capabilities.reasoningEfforts.includes(effort) ? effort : undefined;
}

export { TEXT_TOOL_CAPABILITIES };
