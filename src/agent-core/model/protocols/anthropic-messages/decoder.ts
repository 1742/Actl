import type { ModelTurnEventHandler } from "../../client.js";
import type { ModelFinishReason, ModelUsage, TranscriptItem, TranscriptMessage, TranscriptReasoning, TranscriptToolCall } from "../../types.js";

type Event = Record<string, any>;

export class AnthropicStreamDecoder {
  private messageId: string | undefined;
  private finishReason: ModelFinishReason = "unknown";
  private usage: ModelUsage | undefined;
  private stopped = false;
  private readonly blocks = new Map<number, TranscriptMessage | TranscriptReasoning | TranscriptToolCall>();
  private readonly output: TranscriptItem[] = [];

  constructor(private readonly emit: ModelTurnEventHandler) {}

  async consume(event: Event): Promise<void> {
    if (event.type === "error") throw new Error(event.error?.message ?? "Anthropic stream failed.");
    if (event.type === "message_start") {
      this.messageId = event.message?.id;
      this.updateUsage(event.message?.usage);
      return;
    }
    if (event.type === "message_delta") {
      this.finishReason = mapStopReason(event.delta?.stop_reason);
      this.updateUsage(event.usage);
      return;
    }
    if (event.type === "message_stop") { 
      this.stopped = true; 
      return; 
    }
    if (event.type === "content_block_start") {
      const index = event.index as number;
      const block = event.content_block;
      if (block?.type === "text") {
        const item: TranscriptMessage = { type: "message", id: this.itemId(index), role: "assistant", content: [] };
        this.blocks.set(index, item);
        await this.emit({ type: "output_item_started", item: structuredClone(item) });
        if (block.text) await this.appendText(index, block.text);
      } else if (block?.type === "thinking") {
        const item: TranscriptReasoning = { 
          type: "reasoning", 
          id: this.itemId(index), 
          summary: [], 
          content: [], 
          ...(block.signature ? { anthropicSignature: block.signature } : {}) 
        };
        this.blocks.set(index, item);
        await this.emit({ type: "output_item_started", item: structuredClone(item) });
        if (block.thinking) await this.appendThinking(index, block.thinking);
      } else if (block?.type === "redacted_thinking") {
        const item: TranscriptReasoning = { type: "reasoning", id: this.itemId(index), summary: [], content: [], anthropicRedactedThinking: block.data };
        this.blocks.set(index, item);
        await this.emit({ type: "output_item_started", item: structuredClone(item) });
      } else if (block?.type === "tool_use") {
        const item: TranscriptToolCall = { type: "tool_call", id: this.itemId(index), callId: block.id, name: block.name, argumentsJson: "" };
        this.blocks.set(index, item);
        await this.emit({ type: "output_item_started", item: structuredClone(item) });
        if (block.input && Object.keys(block.input).length) {
          item.argumentsJson = JSON.stringify(block.input);
          await this.emit({ type: "tool_call_delta", itemId: item.id, callId: item.callId, name: item.name, argumentsDelta: item.argumentsJson });
        }
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const index = event.index as number;
      const delta = event.delta;
      if (delta?.type === "text_delta") await this.appendText(index, delta.text);
      else if (delta?.type === "thinking_delta") await this.appendThinking(index, delta.thinking);
      else if (delta?.type === "signature_delta") {
        const item = this.blocks.get(index);
        if (item?.type === "reasoning") item.anthropicSignature = delta.signature;
      } else if (delta?.type === "input_json_delta") {
        const item = this.blocks.get(index);
        if (item?.type === "tool_call") {
          item.argumentsJson += delta.partial_json;
          await this.emit({ type: "tool_call_delta", itemId: item.id, callId: item.callId, argumentsDelta: delta.partial_json });
        }
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const item = this.blocks.get(event.index);
      if (!item) return;
      if (item.type === "tool_call") {
        // Empty tool input is an empty JSON object, never an empty string.
        item.argumentsJson ||= "{}";
        JSON.parse(item.argumentsJson);
      }
      this.output.push(item);
      this.blocks.delete(event.index);
      await this.emit({ type: "output_item_completed", item });
    }
  }

  async finish(): Promise<{ providerRequestId?: string; finishReason: ModelFinishReason; output: TranscriptItem[]; usage?: ModelUsage }> {
    if (!this.stopped) throw new Error("Anthropic stream ended without a message_stop event.");
    if (this.usage) await this.emit({ type: "usage", usage: this.usage });
    return {
      ...(this.messageId ? { providerRequestId: this.messageId } : {}),
      finishReason: this.finishReason, output: this.output,
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private async appendText(index: number, delta: string): Promise<void> {
    const item = this.blocks.get(index);
    if (item?.type !== "message" || !delta) return;
    const part = item.content[0];
    if (part?.type === "text") part.text += delta;
    else item.content.push({ type: "text", text: delta });
    await this.emit({ type: "text_delta", itemId: item.id, contentIndex: 0, delta });
  }

  private async appendThinking(index: number, delta: string): Promise<void> {
    const item = this.blocks.get(index);
    if (item?.type !== "reasoning" || !delta) return;
    const part = item.content[0];
    if (part?.type === "text") part.text += delta;
    else item.content.push({ type: "text", text: delta });
    await this.emit({ type: "reasoning_delta", itemId: item.id, section: "content", contentIndex: 0, delta });
  }

  private updateUsage(value: Event | undefined): void {
    if (!value) return;
    this.usage = {
      inputTokens: value.input_tokens ?? this.usage?.inputTokens,
      outputTokens: value.output_tokens ?? this.usage?.outputTokens,
    };
    if (this.usage.inputTokens !== undefined && this.usage.outputTokens !== undefined)
      this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens;
  }

  private itemId(index: number): string { return `${this.messageId ?? "message"}_block_${index}`; }
}

function mapStopReason(reason: string | null | undefined): ModelFinishReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "length";
  if (reason === "refusal") return "content_filter";
  return "unknown";
}
