import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import type { ModelTurnEventHandler } from "../../client.js";
import type { ModelFinishReason, ModelUsage, TranscriptItem, TranscriptReasoning, TranscriptToolCall } from "../../types.js";

export class ChatStreamDecoder {
  private id: string | undefined;
  private finishReason: ModelFinishReason = "unknown";
  private text = "";
  private refusal = "";
  private messageStarted = false;
  private reasoning = "";
  private reasoningStarted = false;
  private usage: ModelUsage | undefined;
  private readonly toolCalls = new Map<number, TranscriptToolCall>();

  constructor(private readonly emit: ModelTurnEventHandler) {}

  async consume(chunk: ChatCompletionChunk): Promise<void> {
    this.id ??= chunk.id;
    if (chunk.usage) {
      this.usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens, totalTokens: chunk.usage.total_tokens };
      await this.emit({ type: "usage", usage: this.usage });
    }
    for (const choice of chunk.choices) {
      if ((choice.index ?? 0) !== 0) throw new Error("Chat Completions provider received multiple choices; only n=1 is supported.");
      const delta = choice.delta;
      const reasoningDelta = readReasoningContent(delta);
      if (reasoningDelta) {
        await this.ensureReasoningStarted();
        this.reasoning += reasoningDelta;
        await this.emit({ type: "reasoning_delta", itemId: this.reasoningId(), section: "content", contentIndex: 0, delta: reasoningDelta });
      }
      if (delta.content || delta.refusal) await this.ensureMessageStarted();
      if (delta.content) {
        this.text += delta.content;
        await this.emit({ type: "text_delta", itemId: this.messageId(), contentIndex: 0, delta: delta.content });
      }
      if (delta.refusal) this.refusal += delta.refusal;
      for (const part of delta.tool_calls ?? []) {
        const index = part.index;
        let call = this.toolCalls.get(index);
        if (!call) {
          call = { type: "tool_call", id: this.toolId(index), callId: part.id ?? `call_${this.id ?? "stream"}_${index}`, name: "", argumentsJson: "" };
          this.toolCalls.set(index, call);
          await this.emit({ type: "output_item_started", item: structuredClone(call) });
        }
        if (part.id) call.callId = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.argumentsJson += part.function.arguments;
        if (part.function?.name || part.function?.arguments) await this.emit({
          type: "tool_call_delta", itemId: call.id, callId: call.callId,
          ...(part.function.name ? { name: call.name } : {}),
          ...(part.function.arguments ? { argumentsDelta: part.function.arguments } : {}),
        });
      }
      if (choice.finish_reason) this.finishReason = mapFinishReason(choice.finish_reason);
    }
  }

  async finish(): Promise<{ providerRequestId?: string; finishReason: ModelFinishReason; output: TranscriptItem[]; usage?: ModelUsage }> {
    const output: TranscriptItem[] = [];
    if (this.reasoningStarted) {
      const reasoning: TranscriptReasoning = {
        type: "reasoning", id: this.reasoningId(), summary: [],
        content: this.reasoning ? [{ type: "text", text: this.reasoning }] : [],
      };
      output.push(reasoning);
    }
    if (this.messageStarted) {
      const content: Extract<TranscriptItem, { type: "message" }>["content"] = [];
      if (this.text) content.push({ type: "text", text: this.text });
      if (this.refusal) content.push({ type: "refusal", reason: this.refusal });
      if (content.length > 0) output.push({ type: "message", id: this.messageId(), role: "assistant", content });
    }
    output.push(...this.toolCalls.values());
    for (const item of output) await this.emit({ type: "output_item_completed", item });
    return { ...(this.id ? { providerRequestId: this.id } : {}), finishReason: this.finishReason, output, ...(this.usage ? { usage: this.usage } : {}) };
  }

  private async ensureMessageStarted(): Promise<void> {
    if (this.messageStarted) return;
    this.messageStarted = true;
    await this.emit({ type: "output_item_started", item: { type: "message", id: this.messageId(), role: "assistant", content: [] } });
  }

  private async ensureReasoningStarted(): Promise<void> {
    if (this.reasoningStarted) return;
    this.reasoningStarted = true;
    await this.emit({ type: "output_item_started", item: { type: "reasoning", id: this.reasoningId(), summary: [], content: [] } });
  }

  private messageId(): string { return `msg_${this.id ?? "stream"}`; }
  private reasoningId(): string { return `reasoning_${this.id ?? "stream"}`; }
  private toolId(index: number): string { return `tool_${this.id ?? "stream"}_${index}`; }
}

function readReasoningContent(delta: object): string | undefined {
  if (!("reasoning_content" in delta)) return undefined;
  const value = delta.reasoning_content;
  return typeof value === "string" && value ? value : undefined;
}

function mapFinishReason(reason: string): ModelFinishReason {
  return reason === "stop" ? "stop" : reason === "tool_calls" || reason === "function_call" ? "tool_calls" : reason === "length" ? "length" : reason === "content_filter" ? "content_filter" : "unknown";
}
