import { getRequestContext } from "../../observability/request-context.js";
import type { ModelClientConfig } from "../client-config.js";
import type { ModelClient, ModelTurnEventHandler, ModelTurnOptions } from "../client.js";
import { AnthropicStreamDecoder } from "../protocols/anthropic-messages/decoder.js";
import { toAnthropicRequest } from "../protocols/anthropic-messages/encoder.js";
import type { ModelTurnRequest, ModelTurnResult } from "../types.js";

export class AnthropicMessagesDriver implements ModelClient {
  readonly protocol = "anthropic_messages" as const;

  constructor(private readonly config: ModelClientConfig) {}

  async runTurn(request: ModelTurnRequest, emit: ModelTurnEventHandler, options: ModelTurnOptions = {}): Promise<ModelTurnResult> {
    const requestId = getRequestContext()?.requestId;
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 300_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const base = this.config.baseURL.replace(/\/$/, "");
    const endpoint = `${base}${new URL(base).pathname === "/" ? "/v1/" : "/"}messages`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify(toAnthropicRequest(request)),
      signal,
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try { message = JSON.parse(body).error?.message ?? body; } catch { /* Keep raw error text. */ }
      throw new Error(`Anthropic Messages HTTP ${response.status}: ${message}`);
    }
    if (!response.body) throw new Error("Anthropic Messages response has no stream body.");
    const decoder = new AnthropicStreamDecoder(emit);
    for await (const event of readSse(response.body)) await decoder.consume(event);
    return decoder.finish();
  }
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const utf8 = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const parseLine = (line: string): Record<string, unknown> | undefined => {
    if (line === "") {
      if (!data.length) return;
      const payload = data.join("\n");
      data = [];
      if (payload === "[DONE]") return;
      return JSON.parse(payload) as Record<string, unknown>;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    return;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += utf8.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event) yield event;
      }
    }
    buffer += utf8.decode();
    if (buffer) {
      const event = parseLine(buffer.replace(/\r$/, ""));
      if (event) yield event;
    }
    const final = parseLine("");
    if (final) yield final;
  } finally {
    reader.releaseLock();
  }
}
