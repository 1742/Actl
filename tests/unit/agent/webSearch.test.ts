import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentStreamProjector } from "../../../src/agent-core/contracts/agent-responses/stream-projector.js";
import { InMemoryHookEventBus } from "../../../src/agent-core/hooks/event-bus.js";
import { modelCapabilitiesSchema, modelExecutionSnapshotSchema, TEXT_TOOL_CAPABILITIES, type ModelExecutionSnapshot } from "../../../src/agent-core/model/catalog-types.js";
import { ResponsesDriverBase } from "../../../src/agent-core/model/drivers/base.js";
import { createSilentLogger } from "../../../src/agent-core/observability/logger.js";
import { RunPermissionEngine } from "../../../src/agent-core/permissions/engine.js";
import type { AgentRunRecord } from "../../../src/agent-core/runtime/agent-domain.js";
import { AgentLoop } from "../../../src/agent-core/runtime/agent-loop/agent-loop.js";
import type { ModelStore } from "../../../src/agent-core/runtime/model-store.js";
import type { SessionModelContext } from "../../../src/agent-core/runtime/session/session-model-context.js";
import type { SessionTools } from "../../../src/agent-core/runtime/session/session-tools.js";
import type { Session, WorkspaceStore } from "../../../src/agent-core/runtime/workspace-store.js";
import { resolveWebSearchExecutionStrategy } from "../../../src/agent-core/web-search/strategy.js";
import type { AIResponseContext } from "../../../src/renderer/src/agent/components/responses/types.js";
import { reduceResponseEvent } from "../../../src/renderer/src/agent/composables/useResponseReducer.js";
import type { RuntimeWebSearchSettings } from "../../../src/shared/agent/web-search.js";

const official: ModelExecutionSnapshot = {
  targetId: "model", displayName: "DeepSeek", providerModel: "deepseek-v4-pro",
  accountId: "account", accountVersion: 1, credentialVersion: 1,
  baseURL: "https://api.deepseek.com/v1", protocol: "responses",
  capabilities: { ...TEXT_TOOL_CAPABILITIES, nativeWebSearch: "web_search" },
};
const settings: RuntimeWebSearchSettings = {
  provider: "brave", mode: "native", enabled: true,
  baseUrl: "https://api.search.brave.com/res/v1/web/search", hasCredential: true,
};

test("legacy search capability values are read in both model configurations and saved runs", () => {
  assert.equal(modelCapabilitiesSchema.parse({ ...TEXT_TOOL_CAPABILITIES, nativeWebSearch: true }).nativeWebSearch,
    "web_search");
  for (const legacy of [false, "none", undefined]) {
    assert.equal(modelCapabilitiesSchema.parse({ ...TEXT_TOOL_CAPABILITIES, nativeWebSearch: legacy }).nativeWebSearch, "");
  }
  assert.equal(modelCapabilitiesSchema.parse({
    ...TEXT_TOOL_CAPABILITIES, nativeWebSearch: "  deepseek_web_search  ",
  }).nativeWebSearch, "deepseek_web_search");
  assert.equal(modelExecutionSnapshotSchema.parse({
    ...official, capabilities: { ...official.capabilities, nativeWebSearch: "responses_web_search" },
  }).capabilities.nativeWebSearch, "web_search");
});

test("native search uses the configured tool type regardless of model name or host", () => {
  const proxy = {
    ...official,
    baseURL: "https://gateway.example/v1",
    capabilities: { ...official.capabilities, nativeWebSearch: "gateway_search" },
  };
  const unsupported = { ...proxy, capabilities: { ...TEXT_TOOL_CAPABILITIES } };
  const native = { kind: "native", toolType: "gateway_search" };
  assert.deepEqual(resolveWebSearchExecutionStrategy(settings, official), { kind: "native", toolType: "web_search" });
  assert.deepEqual(resolveWebSearchExecutionStrategy(settings, proxy), native);
  assert.deepEqual(resolveWebSearchExecutionStrategy(settings, unsupported), { kind: "unavailable", reason: "native_unsupported" });
  assert.deepEqual(resolveWebSearchExecutionStrategy(settings, { ...official, protocol: "chat_completions" }),
    { kind: "unavailable", reason: "native_unsupported" });
  assert.deepEqual(resolveWebSearchExecutionStrategy(settings, {
    ...official, capabilities: { ...official.capabilities, toolCalling: false },
  }), { kind: "unavailable", reason: "native_unsupported" });
  assert.deepEqual(resolveWebSearchExecutionStrategy({ ...settings, mode: "auto" }, proxy), native);
  assert.deepEqual(resolveWebSearchExecutionStrategy({ ...settings, mode: "auto" }, unsupported),
    { kind: "external", provider: "brave" });
  assert.deepEqual(resolveWebSearchExecutionStrategy({ ...settings, mode: "external" }, official),
    { kind: "external", provider: "brave" });
  assert.deepEqual(resolveWebSearchExecutionStrategy({ ...settings, enabled: false }, official),
    { kind: "unavailable", reason: "disabled" });
});

test("Responses sends the configured search type alongside function tools", async (t) => {
  let request: Request | undefined;
  const output = [{ type: "web_search_call", id: "search", status: "completed", action: { type: "search", queries: ["example"] } }];
  const response = { id: "response", status: "completed", output };
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(url, init);
    return new Response("data: " + JSON.stringify({ type: "response.completed", response }) + "\n\n",
      { headers: { "Content-Type": "text/event-stream" } });
  });

  const driver = new ResponsesDriverBase({
    model: official.providerModel, baseURL: "https://gateway.example/v1", apiKey: "fixture-key", protocol: "responses",
  });
  const answer = await driver.runTurn({
    model: official.providerModel, instructions: "", transcript: [], parallelToolCalls: true,
    nativeWebSearch: "gateway_search",
    tools: [{ name: "web_fetch", description: "Fetch a webpage", inputSchema: { type: "object" } }],
  }, async () => {});

  assert.ok(request);
  assert.equal(request.url, "https://gateway.example/v1/responses");
  const body = await request.json() as { tools: { type: string; name?: string }[] };
  assert.deepEqual(body.tools.map(({ type, name }) => ({ type, name })), [
    { type: "function", name: "web_fetch" }, { type: "gateway_search", name: undefined },
  ]);
  assert.deepEqual(answer.output, [{ type: "web_search", id: "search", status: "completed", action: { type: "search", queries: ["example"] } }]);
});

test("native search answers are merged from the terminal response, and a search without an answer is incomplete", async (t) => {
  const search = {
    type: "web_search_call", id: "search", status: "completed",
    action: { type: "search", queries: ["example"], sources: [{ type: "url", url: "https://example.com/" }] },
  };
  const answerText = "Found the [official site](https://example.com/).";
  const answer = {
    type: "message", id: "answer", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: answerText, annotations: [] }],
  };
  let events: unknown[] = [];
  t.mock.method(globalThis, "fetch", async () => new Response(
    events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  ));
  const client = new ResponsesDriverBase({
    model: official.providerModel, baseURL: "https://gateway.example/v1", apiKey: "fixture-key", protocol: "responses",
  });
  const timestamp = "2026-11-22T00:00:00Z";
  const session: Session = {
    id: "session", ownerId: "owner", projectId: null, cwd: null, created_at: timestamp, updated_at: timestamp,
    runs: [], fileChanges: [], compressionRecords: [],
  };
  const loop = new AgentLoop({
    session,
    prepareModelStep: async () => ({
      prompt: { instructions: "", transcript: [] }, tools: [], nativeWebSearch: "web_search",
    }),
    pendingWait: () => undefined,
    deliverReviewNotifications: async () => false,
  } as unknown as SessionModelContext, {
    getClientForSnapshot: async () => client,
  } as unknown as ModelStore, new InMemoryHookEventBus(), {
    recordProviderResponseId: async () => {},
    touch: async () => {},
  } as unknown as WorkspaceStore, createSilentLogger(), {} as SessionTools, new RunPermissionEngine());

  function terminal(output: unknown[]) {
    return { type: "response.completed", response: { id: "provider-response", status: "completed", output } };
  }
  async function execute() {
    let context: AIResponseContext | undefined;
    const projector = new AgentStreamProjector();
    const run: AgentRunRecord = {
      id: "run", sessionId: session.id, modelSnapshot: official, permissionSnapshot: { permissionMode: "ask" },
      input: [], timeline: [], createdAt: timestamp, updatedAt: timestamp, status: "in_progress", nextSequenceNumber: 0,
    };
    await loop.execute(run, new AbortController().signal, (record, event) => {
      for (const projected of projector.project(run, event)) {
        context = reduceResponseEvent(context, projected).context;
      }
    });
    return { run, context };
  }

  events = [
    { type: "response.output_item.added", item: { ...search, status: "in_progress", action: undefined } },
    { type: "response.output_item.added", item: { ...answer, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: answer.id, content_index: 0, delta: "Found" },
    terminal([search, answer]),
  ];
  const completed = await execute();
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.finalOutput, answerText);
  assert.deepEqual(completed.context?.response.output.map((item) => item.id), ["search", "answer"]);
  assert.equal(completed.context?.response.output[0]?.status, "completed");
  const visibleAnswer = completed.context?.response.output[1];
  assert.equal(visibleAnswer?.type === "message" && visibleAnswer.content[0]?.type === "output_text"
    && visibleAnswer.content[0].text, answerText);

  const preamble = { ...answer, id: "preamble", content: [{ type: "output_text", text: "I will search.", annotations: [] }] };
  events = [terminal([preamble, search])];
  const incomplete = await execute();
  assert.equal(incomplete.run.status, "incomplete");
  assert.equal(incomplete.run.error?.code, "native_search_answer_missing");
  assert.equal(incomplete.context?.response.status, "incomplete");
});
