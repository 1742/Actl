export const DEFAULT_BRAVE_SEARCH_BASE_URL = "https://api.search.brave.com/res/v1/web/search";
export const DEFAULT_TAVILY_SEARCH_BASE_URL = "https://api.tavily.com/search";
export const DEFAULT_SERPER_SEARCH_BASE_URL = "https://google.serper.dev/search";
export const DEFAULT_BOCHA_SEARCH_BASE_URL = "https://api.bocha.cn/v1/web-search";

export type WebSearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  freshness?: WebSearchFreshness;
  domains?: string[];
}
