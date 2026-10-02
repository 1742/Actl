import type { AIWebSearchCallItem } from "../types/aiResponse";
import type { AgentOutputBlock } from "../types";

/** A web search source normalized for display: bare host plus path, with the provider title when present. */
export interface AgentWebSource {
  url: string;
  title: string;
  hostname: string;
  path: string;
  snippet?: string;
  citationId?: number;
}

type AgentActivityBlock = Exclude<AgentOutputBlock, { type: "message" }>;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const stringAt = (record: Record<string, unknown> | null, key: string) => (
  typeof record?.[key] === "string" ? record[key] as string : ""
);

/**
 * `web_search` tool results reach the client either as a bare result array or
 * wrapped in `{ results }`, and providers name the link either `url` or `link`.
 */
export function webSourcesFromOutput(output: unknown): AgentWebSource[] {
  const results = asRecord(output)?.results;
  const values = Array.isArray(output) ? output as unknown[] : Array.isArray(results) ? results : [];
  return dedupeWebSources(values.flatMap((value) => {
    const source = webSourceFromRecord(asRecord(value));
    return source ? [source] : [];
  }));
}

export function webSourcesFromSearchCall(item: AIWebSearchCallItem): AgentWebSource[] {
  return dedupeWebSources((item.action.sources ?? []).flatMap((source) => {
    const normalized = webSourceFromRecord(asRecord(source));
    return normalized ? [normalized] : [];
  }));
}

/** Sources of every web search in the given activity blocks, in search order. */
export function collectWebSources(blocks: AgentActivityBlock[]): AgentWebSource[] {
  return dedupeWebSources(blocks.flatMap((block) => {
    if (block.type === "web_search") return webSourcesFromSearchCall(block.item);
    if (block.type === "tool" && block.presentation === "web") return webSourcesFromOutput(block.result?.output);
    return [];
  }));
}

/** Deduplicated search queries of the given activity blocks, joined for a one-line summary. */
export function collectWebQueries(blocks: AgentActivityBlock[]): string {
  const queries = blocks.flatMap((block) => {
    if (block.type === "web_search") return block.item.action.type === "search" ? block.item.action.queries ?? [] : [];
    if (block.type === "tool" && block.presentation === "web") return [stringAt(block.arguments, "query")];
    return [];
  }).filter(Boolean);
  return [...new Set(queries)].join("、");
}

export function dedupeWebSources(sources: AgentWebSource[]): AgentWebSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function webSourceFromRecord(record: Record<string, unknown> | null): AgentWebSource | null {
  const url = stringAt(record, "url") || stringAt(record, "link");
  if (!url) return null;
  const title = stringAt(record, "title");
  const snippet = stringAt(record, "snippet");
  const citationId = record?.citationId;
  const { hostname, path } = webUrlParts(url);
  return {
    url,
    title: title || hostname,
    hostname,
    path,
    ...(snippet ? { snippet } : {}),
    ...(typeof citationId === "number" ? { citationId } : {}),
  };
}

function webUrlParts(url: string) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./, ""),
      path: decodeURIComponent(`${parsed.pathname}${parsed.search}`).replace(/\/$/, "") || "/",
    };
  } catch {
    return { hostname: url, path: "" };
  }
}
