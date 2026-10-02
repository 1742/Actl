import type { EncryptedSecret } from "../security/encrypted-secret.js";

export const DEFAULT_BRAVE_SEARCH_BASE_URL = "https://api.search.brave.com/res/v1/web/search";
export const DEFAULT_TAVILY_SEARCH_BASE_URL = "https://api.tavily.com/search";
export const DEFAULT_SERPER_SEARCH_BASE_URL = "https://google.serper.dev/search";
export const DEFAULT_BOCHA_SEARCH_BASE_URL = "https://api.bocha.cn/v1/web-search";

export type WebSearchProvider = "brave" | "tavily" | "serper" | "bocha";
export type WebSearchMode = "auto" | "native" | "external";
export type WebSearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchSettingsRecord {
  ownerId: string;
  provider: WebSearchProvider;
  mode: WebSearchMode;
  enabled: boolean;
  baseUrl: string;
  credential?: EncryptedSecret;
  updatedAt: string;
}

export interface WebSearchSettingsView {
  provider: WebSearchProvider;
  mode: WebSearchMode;
  enabled: boolean;
  baseUrl: string;
  hasCredential: boolean;
  updatedAt?: string;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  freshness?: WebSearchFreshness;
  domains?: string[];
}

export interface WebSearchResultItem {
  citationId: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  provider: WebSearchProvider;
  query: string;
  searchedAt: string;
  citationFormat: "markdown-inline";
  citationInstructions: string;
  results: WebSearchResultItem[];
}

export interface WebSearchSettingsRepository {
  getWebSearchSettings(ownerId: string): WebSearchSettingsRecord | undefined;
  upsertWebSearchSettings(record: WebSearchSettingsRecord): Promise<void>;
  clearWebSearchCredential(ownerId: string, updatedAt: string): Promise<void>;
}
