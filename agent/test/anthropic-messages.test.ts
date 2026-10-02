import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicMessagesDriver } from "../src/model/drivers/anthropic-messages.js";
import { toAnthropicRequest } from "../src/model/protocols/anthropic-messages/encoder.js";
import type { ModelTurnEvent, ModelTurnRequest } from "../src/model/types.js";

const request: ModelTurnRequest = {
  model: "claude-test",
  instructions: "Be concise.",
  transcript: [{ type: "message", id: "user_1", role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [{ name: "lookup", description: "Lookup a value", inputSchema: { type: "object", properties: { key: { type: "string" } } } }],
  parallelToolCalls: false,
  maxOutputTokens: 4096,
};

test("Anthropic encoder groups tool calls and results into Messages turns", () => {
  const body = toAnthropicRequest({ ...request, transcript: [
    ...request.transcript,
    { type: "reasoning", id: "reasoning_1", summary: [], content: [{ type: "text", text: "Think" }], anthropicSignature: "sig" },
    { type: "reasoning", id: "reasoning_2", summary: [], content: [], anthropicRedactedThinking: "opaque" },
    { type: "tool_call", id: "call_1", callId: "toolu_1", name: "lookup", argumentsJson: '{"key":"x"}' },
    { type: "tool_result", id: "result_1", callId: "toolu_1", content: [{ type: "text", text: "Found" }], isError: false },
    { type: "message", id: "user_2", role: "user", content: [{ type: "text", text: "Continue" }] },
  ] });
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Think", signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "toolu_1", name: "lookup", input: { key: "x" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Found", is_error: false }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ]);
  assert.deepEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("Anthropic driver decodes split SSE chunks, tool JSON, thinking signature and usage", async () => {
  const originalFetch = globalThis.fetch;
  const events: ModelTurnEvent[] = [];
  let sentBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    assert.equal(_url, "https://api.anthropic.com/v1/messages");
    assert.equal(new Headers(init?.headers).get("anthropic-version"), "2023-06-01");
    sentBody = JSON.parse(String(init?.body));
    const payload = [
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Looking" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"key":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"x"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      { type: "message_stop" },
    ].map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
    const bytes = new TextEncoder().encode(payload);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 13));
      controller.enqueue(bytes.slice(13, 127));
      controller.enqueue(bytes.slice(127));
      controller.close();
    } }), { status: 200 });
  };
  try {
    const driver = new AnthropicMessagesDriver({ model: request.model, protocol: "anthropic_messages", baseURL: "https://api.anthropic.com/v1", apiKey: "test" });
    const result = await driver.runTurn(request, (event) => { events.push(event); });
    assert.equal(sentBody?.max_tokens, 4096);
    assert.equal(result.providerRequestId, "msg_1");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 12, totalTokens: 22 });
    assert.deepEqual(result.output, [
      { type: "reasoning", id: "msg_1_block_0", summary: [], content: [{ type: "text", text: "Check" }], anthropicSignature: "sig" },
      { type: "message", id: "msg_1_block_1", role: "assistant", content: [{ type: "text", text: "Looking" }] },
      { type: "tool_call", id: "msg_1_block_2", callId: "toolu_1", name: "lookup", argumentsJson: '{"key":"x"}' },
    ]);
    assert.ok(events.some((event) => event.type === "tool_call_delta"));
  } finally { globalThis.fetch = originalFetch; }
});
