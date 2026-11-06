import type { SecretProtector } from "../security/secret-protector.js";
import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import { nowIso } from "../utils.js";
import {
  DEFAULT_BRAVE_SEARCH_BASE_URL,
  DEFAULT_BOCHA_SEARCH_BASE_URL,
  DEFAULT_SERPER_SEARCH_BASE_URL,
  DEFAULT_TAVILY_SEARCH_BASE_URL,
  type WebSearchRequest,
  type WebSearchResult,
  type WebSearchResultItem,
  type WebSearchMode,
  type WebSearchProvider,
  type WebSearchSettingsRecord,
  type WebSearchSettingsRepository,
  type WebSearchSettingsView,
} from "./types.js";
import { resolveWebSearchExecutionStrategy, type WebSearchExecutionStrategy } from "./strategy.js";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESULT_COUNT = 8;
const BRAVE_FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
const CITATION_INSTRUCTIONS = "When using search results in the answer, cite the supporting source immediately after the claim using an inline Markdown link such as [1](https://example.com). Replace 1 with the result's citationId and use that result's exact url. Use only URLs returned by this tool.";

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  age?: unknown;
  page_age?: unknown;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

interface TavilyResponse { results?: Array<{ title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }> }
interface SerperResponse { organic?: Array<{ title?: unknown; link?: unknown; snippet?: unknown; date?: unknown }> }
interface BochaResponse { data?: { webPages?: { value?: Array<{ name?: unknown; url?: unknown; snippet?: unknown; summary?: unknown; datePublished?: unknown }> } } }

export interface ConfigureWebSearchInput {
  enabled: boolean;
  provider?: WebSearchProvider;
  mode?: WebSearchMode;
  baseUrl?: string;
  apiKey?: string;
}

export type WebSearchServiceErrorCode =
  | "web_search_disabled"
  | "web_search_native_unavailable"
  | "web_search_credential_missing"
  | "web_search_config_invalid"
  | "web_search_auth_failed"
  | "web_search_rate_limited"
  | "web_search_provider_timeout"
  | "web_search_provider_unavailable";

export class WebSearchServiceError extends Error {
  constructor(readonly code: WebSearchServiceErrorCode, message: string) {
    super(message);
    this.name = "WebSearchServiceError";
  }
}

export class WebSearchService {
  constructor(
    private readonly repository: WebSearchSettingsRepository,
    private readonly credentials: SecretProtector,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getSettings(ownerId: string): WebSearchSettingsView {
    const record = this.repository.getWebSearchSettings(ownerId);
    return record ? {
      provider: record.provider,
      mode: record.mode,
      enabled: record.enabled,
      baseUrl: record.baseUrl,
      hasCredential: Boolean(record.credential),
      updatedAt: record.updatedAt,
    } : {
      provider: "brave",
      mode: "auto",
      enabled: false,
      baseUrl: DEFAULT_BRAVE_SEARCH_BASE_URL,
      hasCredential: false,
    };
  }

  async configure(ownerId: string, input: ConfigureWebSearchInput): Promise<WebSearchSettingsView> {
    const existing = this.repository.getWebSearchSettings(ownerId);
    const mode = input.mode ?? existing?.mode ?? "auto";
    const provider = input.provider ?? existing?.provider ?? "brave";
    const apiKey = input.apiKey?.trim();
    const credential = apiKey ? this.credentials.encrypt(apiKey)
      : input.provider && input.provider !== existing?.provider ? undefined : existing?.credential;
    if (input.enabled && mode === "external" && !credential) throw new WebSearchServiceError(
      "web_search_credential_missing",
      `A ${providerName(provider)} API key is required before external web search can be enabled.`,
    );
    await this.repository.upsertWebSearchSettings({
      ownerId,
      provider,
      mode,
      enabled: input.enabled,
      baseUrl: normalizeBaseUrl(input.baseUrl ?? (input.provider && input.provider !== existing?.provider
        ? defaultBaseUrl(provider) : existing?.baseUrl) ?? defaultBaseUrl(provider)),
      ...(credential ? { credential } : {}),
      updatedAt: nowIso(),
    });
    return this.getSettings(ownerId);
  }

  async clearCredential(ownerId: string): Promise<WebSearchSettingsView> {
    await this.repository.clearWebSearchCredential(ownerId, nowIso());
    return this.getSettings(ownerId);
  }

  resolveExecutionStrategy(ownerId: string, model: ModelExecutionSnapshot): WebSearchExecutionStrategy {
    return resolveWebSearchExecutionStrategy(this.getSettings(ownerId), model);
  }

  async test(ownerId: string, signal?: AbortSignal): Promise<WebSearchResult> {
    const settings = this.repository.getWebSearchSettings(ownerId);
    if (!settings?.credential) throw new WebSearchServiceError(
      "web_search_credential_missing",
      `${providerName(settings?.provider ?? "brave")} API key is not configured.`,
    );
    return this.executeSearch(
      { ...settings, credential: settings.credential },
      { query: `${providerName(settings.provider)} Search API`, maxResults: 1 },
      signal,
    );
  }

  async search(ownerId: string, input: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const settings = this.repository.getWebSearchSettings(ownerId);
    if (!settings?.enabled) throw new WebSearchServiceError(
      "web_search_disabled",
      "Web search is disabled. Ask the user to enable it in Settings > Web Search before retrying.",
    );
    if (settings.mode === "native") throw new WebSearchServiceError(
      "web_search_native_unavailable",
      "The selected model does not support provider-native web search. Ask the user to choose Auto or Brave Search in Settings > Web Search, or switch to a supported provider.",
    );
    if (!settings.credential) throw new WebSearchServiceError(
      "web_search_credential_missing",
      "Web search has no API key. Ask the user to configure one in Settings > Web Search before retrying.",
    );

    return this.executeSearch({ ...settings, credential: settings.credential }, input, signal);
  }

  private async executeSearch(
    settings: WebSearchSettingsRecord & { credential: NonNullable<WebSearchSettingsRecord["credential"]> },
    input: WebSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const request = createProviderRequest(settings, this.credentials.decrypt(settings.credential), input);

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body } : {}),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutSignal.aborted) throw new WebSearchServiceError(
        "web_search_provider_timeout",
        `${providerName(settings.provider)} Search request timed out.`,
      );
      throw new WebSearchServiceError(
        "web_search_provider_unavailable",
        `${providerName(settings.provider)} Search is currently unavailable.`,
      );
    }
    if (!response.ok) throw searchHttpError(settings.provider, response.status);
    const payload = await response.json() as unknown;
    const results = providerResults(settings.provider, payload)
      .filter((item): item is Omit<WebSearchResultItem, "citationId"> => item !== null)
      .slice(0, input.maxResults ?? DEFAULT_RESULT_COUNT)
      .map((item, index) => ({ ...item, citationId: index + 1 }));
    return {
      provider: settings.provider,
      query: input.query.trim(),
      searchedAt: nowIso(),
      citationFormat: "markdown-inline",
      citationInstructions: CITATION_INSTRUCTIONS,
      results,
    };
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new WebSearchServiceError("web_search_config_invalid", "Web search Base URL is invalid.");
  }
  if (url.protocol !== "https:") throw new WebSearchServiceError(
    "web_search_config_invalid",
    "Web search Base URL must use HTTPS.",
  );
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

function withDomainFilters(query: string, domains?: string[]): string {
  if (!domains?.length) return query;
  const filter = domains.map((domain) => `site:${domain}`).join(" OR ");
  return `${query} (${filter})`;
}

function defaultBaseUrl(provider: WebSearchProvider): string {
  return provider === "bocha" ? DEFAULT_BOCHA_SEARCH_BASE_URL
    : provider === "tavily" ? DEFAULT_TAVILY_SEARCH_BASE_URL
    : provider === "serper" ? DEFAULT_SERPER_SEARCH_BASE_URL
      : DEFAULT_BRAVE_SEARCH_BASE_URL;
}

function providerName(provider: WebSearchProvider): string {
  return provider === "bocha" ? "博查" : provider === "tavily" ? "Tavily" : provider === "serper" ? "Serper" : "Brave Search";
}

function createProviderRequest(
  settings: WebSearchSettingsRecord,
  apiKey: string,
  input: WebSearchRequest,
): { url: URL; method: "GET" | "POST"; headers: HeadersInit; body?: string } {
  const query = input.query.trim();
  const maxResults = input.maxResults ?? DEFAULT_RESULT_COUNT;
  if (settings.provider === "brave") {
    const url = new URL(settings.baseUrl);
    url.searchParams.set("q", withDomainFilters(query, input.domains));
    url.searchParams.set("count", String(maxResults));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("extra_snippets", "true");
    if (input.freshness) url.searchParams.set("freshness", BRAVE_FRESHNESS[input.freshness]);
    return { url, method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": apiKey } };
  }
  const body = settings.provider === "bocha"
    ? {
        query, count: Math.min(maxResults, 50), summary: true,
        ...(input.domains?.length ? { include: input.domains.join(",") } : {}),
        ...(input.freshness ? { freshness: { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" }[input.freshness] } : {}),
      }
    : settings.provider === "tavily"
    ? {
        api_key: apiKey, query, max_results: maxResults, search_depth: "basic",
        ...(input.domains?.length ? { include_domains: input.domains } : {}),
        ...(input.freshness ? { days: { day: 1, week: 7, month: 30, year: 365 }[input.freshness] } : {}),
      }
    : {
        q: withDomainFilters(query, input.domains), num: maxResults,
        ...(input.freshness ? { tbs: { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[input.freshness] } : {}),
      };
  return {
    url: new URL(settings.baseUrl), method: "POST",
    headers: settings.provider === "bocha"
      ? { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }
      : settings.provider === "tavily"
      ? { Accept: "application/json", "Content-Type": "application/json" }
      : { Accept: "application/json", "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify(body),
  };
}

function providerResults(provider: WebSearchProvider, payload: unknown): Array<Omit<WebSearchResultItem, "citationId"> | null> {
  if (!payload || typeof payload !== "object") return [];
  if (provider === "brave") return ((payload as BraveResponse).web?.results ?? []).map(toBraveSearchResult);
  if (provider === "tavily") return ((payload as TavilyResponse).results ?? []).map((result) => toGenericSearchResult(
    result.title, result.url, result.content, result.published_date,
  ));
  if (provider === "bocha") return ((payload as BochaResponse).data?.webPages?.value ?? []).map((result) => toGenericSearchResult(
    result.name, result.url, result.summary ?? result.snippet, result.datePublished,
  ));
  return ((payload as SerperResponse).organic ?? []).map((result) => toGenericSearchResult(
    result.title, result.link, result.snippet, result.date,
  ));
}

function toGenericSearchResult(
  title: unknown, value: unknown, snippet: unknown, publishedAt: unknown,
): Omit<WebSearchResultItem, "citationId"> | null {
  if (typeof title !== "string" || typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    title: plainText(title), url: url.toString(),
    snippet: typeof snippet === "string" ? plainText(snippet) : "",
    ...(typeof publishedAt === "string" ? { publishedAt } : {}),
  };
}

function toBraveSearchResult(value: BraveWebResult): Omit<WebSearchResultItem, "citationId"> | null {
  if (typeof value.title !== "string" || typeof value.url !== "string") return null;
  let url: URL;
  try { url = new URL(value.url); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const publishedAt = typeof value.page_age === "string"
    ? value.page_age
    : typeof value.age === "string" ? value.age : undefined;
  return {
    title: plainText(value.title),
    url: url.toString(),
    snippet: typeof value.description === "string" ? plainText(value.description) : "",
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function searchHttpError(provider: WebSearchProvider, status: number): WebSearchServiceError {
  if (status === 401 || status === 403) return new WebSearchServiceError(
    "web_search_auth_failed",
    `${providerName(provider)} rejected the API key.`,
  );
  if (status === 429) return new WebSearchServiceError(
    "web_search_rate_limited",
    `${providerName(provider)} rate limit exceeded.`,
  );
  return new WebSearchServiceError(
    "web_search_provider_unavailable",
    `${providerName(provider)} request failed with HTTP ${status}.`,
  );
}
