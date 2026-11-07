export type WebSearchProvider = "brave" | "tavily" | "serper" | "bocha";
export type WebSearchMode = "auto" | "native" | "external";

export interface RuntimeWebSearchSettings {
  provider: WebSearchProvider;
  mode: WebSearchMode;
  enabled: boolean;
  baseUrl: string;
  hasCredential: boolean;
  updatedAt?: string;
}

export interface RuntimeWebSearchResult {
  provider: WebSearchProvider;
  query: string;
  searchedAt: string;
  citationFormat: "markdown-inline";
  citationInstructions: string;
  results: WebSearchResultItem[];
}

export interface WebSearchResultItem {
  citationId: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}
