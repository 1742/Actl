import type { Response, ResponseFunctionWebSearch, ResponseOutputItem, ResponseOutputText, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ModelTurnEventHandler } from "../../client.js";
import type {
  ContentPart, ModelFinishReason, ModelUsage, TranscriptItem, TranscriptMessage, TranscriptReasoning, TranscriptToolCall, TranscriptWebSearch,
} from "../../types.js";

export async function consumeResponseEvent(
  event: ResponseStreamEvent,
  items: Map<string, TranscriptMessage | TranscriptReasoning | TranscriptToolCall | TranscriptWebSearch>,
  emit: ModelTurnEventHandler,
): Promise<void> {
  if (event.type === "response.output_item.added") {
    const item = fromResponseOutput(event.item);
    if (item?.type === "message" || item?.type === "reasoning" || item?.type === "tool_call" || item?.type === "web_search") {
      items.set(item.id, item);
      await emit({ type: "output_item_started", item });
    }
  } else if (event.type === "response.output_text.delta") {
    await emit({ type: "text_delta", itemId: event.item_id, contentIndex: event.content_index, delta: event.delta });
  } else if (event.type === "response.reasoning_summary_text.delta") {
    await emit({ type: "reasoning_delta", itemId: event.item_id, section: "summary", contentIndex: event.summary_index, delta: event.delta });
  } else if (event.type === "response.reasoning_text.delta") {
    await emit({ type: "reasoning_delta", itemId: event.item_id, section: "content", contentIndex: event.content_index, delta: event.delta });
  } else if (event.type === "response.function_call_arguments.delta") {
    const item = items.get(event.item_id);
    if (item?.type === "tool_call") await emit({ type: "tool_call_delta", itemId: item.id, callId: item.callId, argumentsDelta: event.delta });
  } else if (event.type === "response.output_item.done") {
    const item = fromResponseOutput(event.item);
    if (item) await emit({ type: "output_item_completed", item });
  }
}

export function decodeTerminal(response: Response): { output: TranscriptItem[]; finishReason: ModelFinishReason; usage?: ModelUsage } {
  const output = response.output.map(fromResponseOutput).filter((item): item is TranscriptItem => item !== null);
  const reason = response.incomplete_details?.reason;
  const finishReason: ModelFinishReason = reason === "max_output_tokens"
    ? "length"
    : reason === "content_filter"
      ? "content_filter"
      : response.status === "incomplete"
        ? "unknown"
      : output.some((item) => item.type === "tool_call") ? "tool_calls" : "stop";
  const usage = response.usage ? {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.total_tokens,
  } : undefined;
  return { output, finishReason, ...(usage ? { usage } : {}) };
}

function fromResponseOutput(item: ResponseOutputItem): TranscriptItem | null {
  if (item.type === "reasoning") return {
    type: "reasoning", 
    id: item.id,
    summary: item.summary.flatMap((part): ContentPart[] => part.type === "summary_text" ? [{ type: "text", text: part.text }] : []),
    content: (item.content ?? []).flatMap((part): ContentPart[] => part.type === "reasoning_text" ? [{ type: "text", text: part.text }] : []),
    ...(item.encrypted_content ? { encryptedContent: item.encrypted_content } : {}),
  };
  if (item.type === "message") return {
    type: "message", 
    id: item.id, 
    role: "assistant",
    content: item.content.flatMap((part): ContentPart[] => part.type === "output_text"
      ? [{ type: "text", text: withMarkdownCitations(part.text, part.annotations) }]
      : part.type === "refusal" ? [{ type: "refusal", reason: part.refusal }] : []),
  };
  if (item.type === "function_call") return { 
    type: "tool_call", 
    id: item.id ?? item.call_id, 
    callId: item.call_id, 
    name: item.name, 
    argumentsJson: item.arguments 
  };
  if (item.type === "function_call_output") return {
    type: "tool_result", 
    id: item.id ?? item.call_id, 
    callId: item.call_id,
    content: [{ type: "text", text: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }], 
    isError: false,
  };
  if (item.type === "web_search_call") return fromWebSearchCall(item);
  return null;
}

function fromWebSearchCall(item: ResponseFunctionWebSearch): TranscriptWebSearch {
  const action = item.action;
  // The streaming `output_item.added` event can announce a web search before
  // the provider attaches its action. The later `output_item.done` event
  // replaces this placeholder with the completed query and sources.
  if (!action) return {
    type: "web_search", id: item.id, status: item.status,
    action: { type: "search", queries: [] },
  };
  if (action.type === "search") return {
    type: "web_search", id: item.id, status: item.status,
    action: {
      type: "search", queries: action.queries ?? [],
      ...(action.sources ? { sources: action.sources } : {}),
    },
  };
  if (action.type === "open_page") return {
    type: "web_search", id: item.id, status: item.status,
    action: { type: "open_page", ...(action.url ? { url: action.url } : {}) },
  };
  return { type: "web_search", id: item.id, status: item.status, action: { type: "find_in_page", url: action.url, pattern: action.pattern } };
}

export function withMarkdownCitations(
  text: string,
  annotations: ResponseOutputText["annotations"],
): string {
  const citations = annotations
    .filter((annotation): annotation is ResponseOutputText.URLCitation => annotation.type === "url_citation")
    .filter((annotation) => isHttpUrl(annotation.url)
      && annotation.start_index >= 0
      && annotation.end_index >= annotation.start_index
      && annotation.end_index <= text.length)
    .sort((left, right) => left.start_index - right.start_index);
  if (citations.length === 0) return text;

  const idsByUrl = new Map<string, number>();
  const alreadyLinked = new Set(citations
    .filter((citation) => text.includes(`](${citation.url.replaceAll(")", "%29")})`))
    .map((citation) => citation.url));
  const numbered = citations.map((citation) => {
    let citationId = idsByUrl.get(citation.url);
    if (citationId === undefined) {
      citationId = idsByUrl.size + 1;
      idsByUrl.set(citation.url, citationId);
    }
    return { citation, citationId };
  });

  const groups = new Map<string, { start: number; end: number; labels: string[] }>();
  for (const { citation, citationId } of numbered) {
    if (alreadyLinked.has(citation.url)) continue;
    const key = `${citation.start_index}:${citation.end_index}`;
    const group = groups.get(key) ?? { start: citation.start_index, end: citation.end_index, labels: [] };
    const label = `[${citationId}](${citation.url.replaceAll(")", "%29")})`;
    if (!group.labels.includes(label)) group.labels.push(label);
    groups.set(key, group);
  }

  let result = text;
  const orderedGroups = [...groups.values()].sort((left, right) => right.end - left.end || right.start - left.start);
  for (const group of orderedGroups) {
    const labels = group.labels.join("");
    const annotatedText = result.slice(group.start, group.end);
    if (/cite.*?/u.test(annotatedText)) {
      const normalized = annotatedText.replace(/cite.*?/gu, labels);
      result = `${result.slice(0, group.start)}${normalized}${result.slice(group.end)}`;
    } else {
      result = `${result.slice(0, group.end)}${labels}${result.slice(group.end)}`;
    }
  }
  return result;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
