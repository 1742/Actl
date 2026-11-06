import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions";
import type { Response, ResponseCreateParamsStreaming } from "openai/resources/responses/responses";
import { getRequestContext } from "../../observability/request-context.js";
import type { ModelClientConfig } from "../client-config.js";
import type { ModelClient, ModelTurnEventHandler, ModelTurnOptions } from "../client.js";
import type { ModelTurnRequest, ModelTurnResult, TranscriptMessage, TranscriptReasoning, TranscriptToolCall } from "../types.js";
import { ChatStreamDecoder } from "../protocols/chat-completions/decoder.js";
import { toChatMessages, toChatTools } from "../protocols/chat-completions/encoder.js";
import { consumeResponseEvent, decodeTerminal } from "../protocols/responses/decoder.js";
import { toResponseInput, toResponseTools } from "../protocols/responses/encoder.js";

export class ResponsesDriverBase implements ModelClient {
  readonly protocol = "responses" as const;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(protected readonly config: ModelClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.client = createOpenAIClient(config, this.timeoutMs);
  }

  async runTurn(request: ModelTurnRequest, emit: ModelTurnEventHandler, options: ModelTurnOptions = {}): Promise<ModelTurnResult> {
    const requestId = getRequestContext()?.requestId;
    const body = {
      model: request.model,
      input: toResponseInput(request.transcript),
      ...(request.instructions ? { instructions: request.instructions } : {}),
      tools: toResponseTools(request.tools, request.nativeWebSearch),
      parallel_tool_calls: request.parallelToolCalls,
      include: [
        "reasoning.encrypted_content",
        ...(request.nativeWebSearch ? ["web_search_call.action.sources" as const] : []),
      ],
      ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort, summary: "auto" } } : {}),
      stream: true,
    } as unknown as ResponseCreateParamsStreaming;
    const stream = await this.client.responses.create(body, requestOptions(requestId, options.signal));
    const items = new Map<string, TranscriptMessage | TranscriptReasoning | TranscriptToolCall>();
    let terminal: Response | undefined;
    const streamStart = Date.now();
    for await (const event of stream) {
      assertStreamDuration(streamStart, this.timeoutMs);
      await consumeResponseEvent(event, items, emit);
      if (event.type === "response.completed" || event.type === "response.incomplete") terminal = event.response;
      else if (event.type === "response.failed") throw new Error(event.response.error?.message ?? "Model response failed.");
      else if (event.type === "error") throw new Error(event.message);
    }
    if (!terminal) throw new Error("Model stream ended without a terminal response event.");
    const decoded = decodeTerminal(terminal);
    if (decoded.usage) await emit({ type: "usage", usage: decoded.usage });
    return { providerRequestId: terminal.id, ...decoded };
  }
}

export class ChatCompletionsDriverBase implements ModelClient {
  readonly protocol = "chat_completions" as const;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(protected readonly config: ModelClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.client = createOpenAIClient(config, this.timeoutMs);
  }

  protected reasoningParameters(effort: ModelTurnRequest["reasoningEffort"]): Record<string, unknown> {
    return effort ? { reasoning_effort: effort } : {};
  }

  async runTurn(request: ModelTurnRequest, emit: ModelTurnEventHandler, options: ModelTurnOptions = {}): Promise<ModelTurnResult> {
    const requestId = getRequestContext()?.requestId;
    const body = {
      model: request.model,
      messages: toChatMessages(request.instructions, request.transcript),
      tools: toChatTools(request.tools),
      parallel_tool_calls: request.parallelToolCalls,
      stream: true,
      stream_options: { include_usage: true },
      ...this.reasoningParameters(request.reasoningEffort),
    } as ChatCompletionCreateParamsStreaming;
    const stream = await this.client.chat.completions.create(body, requestOptions(requestId, options.signal));
    const decoder = new ChatStreamDecoder(emit);
    const streamStart = Date.now();
    for await (const chunk of stream) {
      assertStreamDuration(streamStart, this.timeoutMs);
      await decoder.consume(chunk);
    }
    return decoder.finish();
  }
}

function createOpenAIClient(config: ModelClientConfig, timeoutMs: number): OpenAI {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, logLevel: "off", timeout: timeoutMs, maxRetries: 0 });
}

function requestOptions(requestId: string | undefined, signal: AbortSignal | undefined) {
  return {
    ...(requestId ? { headers: { "X-Request-Id": requestId } } : {}),
    ...(signal ? { signal } : {}),
  };
}

function assertStreamDuration(startedAt: number, timeoutMs: number): void {
  if (Date.now() - startedAt > timeoutMs + 30_000) throw new Error("Model stream exceeded maximum duration.");
}
