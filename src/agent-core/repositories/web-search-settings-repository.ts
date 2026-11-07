import type { WebSearchMode, WebSearchProvider } from "../../shared/agent/web-search.js";
import type { EncryptedSecret } from "../security/encrypted-secret.js";

export interface WebSearchSettingsRecord {
  ownerId: string;
  provider: WebSearchProvider;
  mode: WebSearchMode;
  enabled: boolean;
  baseUrl: string;
  credential?: EncryptedSecret;
  updatedAt: string;
}

export interface WebSearchSettingsRepository {
  getWebSearchSettings(ownerId: string): WebSearchSettingsRecord | undefined;
  upsertWebSearchSettings(record: WebSearchSettingsRecord): Promise<void>;
  clearWebSearchCredential(ownerId: string, updatedAt: string): Promise<void>;
}
