import type { Response } from "express";
import { currentOwnerId } from "../../auth/runtime-auth.js";
import type { ProviderAccountRecord } from "../../model/catalog-types.js";
import type { ModelStore, ProviderAccountView } from "../../runtime/model-store.js";
import { TEXT_TOOL_CAPABILITIES } from "../../runtime/model-store.js";
import { validated } from "../common/validation.js";
import type { CreateModelBody } from "../models/model.schemas.js";
import type { z } from "zod";
import type { createProviderAccountBodySchema, editProviderAccountBodySchema, providerAccountParamsSchema, replaceCredentialBodySchema } from "./provider-account.schemas.js";

type Params = z.infer<typeof providerAccountParamsSchema>;
type CreateBody = z.infer<typeof createProviderAccountBodySchema>;
type EditBody = z.infer<typeof editProviderAccountBodySchema>;
type CredentialBody = z.infer<typeof replaceCredentialBodySchema>;

export function createProviderAccountHandlers(store: ModelStore) {
  return {
    list(_request: unknown, response: Response): void {
      response.json({ data: store.listProviderAccounts(currentOwnerId(response)).map(toDto) });
    },
    async create(_request: unknown, response: Response): Promise<void> {
      const body = validated<CreateBody>(response, "body");
      const account = await store.createProviderAccount(currentOwnerId(response), body);
      response.status(201).json(toDto(account));
    },
    async edit(_request: unknown, response: Response): Promise<void> {
      const { accountId } = validated<Params>(response, "params");
      const body = validated<EditBody>(response, "body");
      response.json(toDto(await store.updateProviderAccount(currentOwnerId(response), accountId, {
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      })));
    },
    async replaceCredential(_request: unknown, response: Response): Promise<void> {
      const { accountId } = validated<Params>(response, "params");
      const { apiKey } = validated<CredentialBody>(response, "body");
      await store.replaceCredential(currentOwnerId(response), accountId, apiKey);
      response.status(204).send();
    },
    async clearCredential(_request: unknown, response: Response): Promise<void> {
      const { accountId } = validated<Params>(response, "params");
      await store.clearCredential(currentOwnerId(response), accountId);
      response.status(204).send();
    },
    async remove(_request: unknown, response: Response): Promise<void> {
      const { accountId } = validated<Params>(response, "params");
      await store.deleteProviderAccount(currentOwnerId(response), accountId);
      response.status(204).send();
    },
    async createModel(_request: unknown, response: Response): Promise<void> {
      const { accountId } = validated<Params>(response, "params");
      const body = validated<CreateModelBody>(response, "body");
      response.status(201).json(await store.createModelTarget(currentOwnerId(response), accountId, {
        providerModel: body.providerModel, displayName: body.displayName,
        protocol: body.protocol,
        capabilities: body.capabilities ?? structuredClone(TEXT_TOOL_CAPABILITIES),
      }));
    },
  };
}

function toDto(account: ProviderAccountRecord | ProviderAccountView) {
  if ("hasCredential" in account) return account;
  return {
    id: account.id, displayName: account.displayName,
    baseURL: account.baseURL, enabled: account.enabled,
    hasCredential: account.credentialVersion !== null, createdAt: account.createdAt, updatedAt: account.updatedAt,
  };
}
