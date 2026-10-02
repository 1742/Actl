import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecretProtector } from "../src/security/secret-protector.js";
import { modelCapabilitiesSchema, type ModelExecutionSnapshot } from "../src/model/catalog-types.js";
import { toResponseInput, toResponseTools } from "../src/model/protocols/responses/encoder.js";
import { decodeTerminal, withMarkdownCitations } from "../src/model/protocols/responses/decoder.js";
import { SqliteWorkspaceRepository } from "../src/repositories/sqlite-workspace-repository.js";
import { runSqliteMigrations } from "../src/repositories/sqlite/migrations/index.js";
import { SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from "../src/repositories/sqlite/schema.js";
import { WebSearchService } from "../src/web-search/search-service.js";
import type { WebSearchSettingsRecord, WebSearchSettingsRepository } from "../src/web-search/types.js";

class MemoryRepository implements WebSearchSettingsRepository {
  record?: WebSearchSettingsRecord;

  getWebSearchSettings(ownerId: string): WebSearchSettingsRecord | undefined {
    return this.record?.ownerId === ownerId ? this.record : undefined;
  }

  async upsertWebSearchSettings(record: WebSearchSettingsRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  async clearWebSearchCredential(ownerId: string, updatedAt: string): Promise<void> {
    if (!this.record || this.record.ownerId !== ownerId) return;
    this.record = { ...this.record, enabled: this.record.mode === "external" ? false : this.record.enabled, updatedAt };
    delete this.record.credential;
  }
}

const credentials = {
  encrypt(value: string) {
    return { ciphertext: Buffer.from(value), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16), keyVersion: 1 };
  },
  decrypt(value: { ciphertext: Buffer }) { return Buffer.from(value.ciphertext).toString("utf8"); },
} as unknown as SecretProtector;

test("defaults native search off for existing model capability records", () => {
  const capabilities = modelCapabilitiesSchema.parse({
    input: { text: true, imageMimeTypes: [], audioMimeTypes: [] },
    toolCalling: true,
    parallelToolCalls: true,
    reasoningEfforts: [],
  });

  assert.equal(capabilities.nativeWebSearch, false);
});

test("configures an external search provider without returning the API key", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  const view = await service.configure("owner", { enabled: true, apiKey: "secret-key" });

  assert.equal(view.enabled, true);
  assert.equal(view.mode, "auto");
  assert.equal(view.hasCredential, true);
  assert.equal("apiKey" in view, false);
  assert.ok(repository.record?.credential);
});

test("allows native and automatic search modes without an external credential", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);

  assert.equal((await service.configure("owner", { enabled: true, mode: "native" })).enabled, true);
  assert.equal((await service.configure("owner", { enabled: true, mode: "auto" })).enabled, true);
  await assert.rejects(
    () => service.configure("other", { enabled: true, mode: "external" }),
    /API key is required/,
  );
});

test("selects native search by model capability and falls back to the external tool", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  await service.configure("owner", { enabled: true, mode: "auto" });
  const openai = { providerType: "openai", protocol: "responses", capabilities: { nativeWebSearch: true } } as ModelExecutionSnapshot;
  const compatible = { providerType: "openai_compatible", protocol: "responses", capabilities: { nativeWebSearch: true } } as ModelExecutionSnapshot;
  const deepseek = { providerType: "deepseek", protocol: "chat_completions", capabilities: { nativeWebSearch: false } } as ModelExecutionSnapshot;

  assert.deepEqual(service.resolveExecutionStrategy("owner", openai), { kind: "native", provider: "openai_responses" });
  assert.deepEqual(service.resolveExecutionStrategy("owner", compatible), { kind: "native", provider: "openai_responses" });
  assert.deepEqual(service.resolveExecutionStrategy("owner", deepseek), { kind: "unavailable", reason: "credential_missing" });

  await service.configure("owner", { enabled: true, mode: "auto", apiKey: "secret-key" });
  assert.deepEqual(service.resolveExecutionStrategy("owner", deepseek), { kind: "external", provider: "brave" });

  await service.configure("owner", { enabled: true, mode: "external", apiKey: "secret-key" });
  assert.deepEqual(service.resolveExecutionStrategy("owner", openai), { kind: "external", provider: "brave" });
});

test("reports an actionable error when native-only search is used by an unsupported model", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  await service.configure("owner", { enabled: true, mode: "native" });

  await assert.rejects(() => service.search("owner", { query: "latest" }), {
    code: "web_search_native_unavailable",
  });
});

test("encodes the OpenAI native web search tool", () => {
  assert.deepEqual(toResponseTools([], true), [{ type: "web_search" }]);
  assert.deepEqual(toResponseTools([], false), []);
});

test("keeps provider-native web search sources in the transcript", () => {
  const response = {
    status: "completed",
    output: [{
      id: "ws_1", type: "web_search_call", status: "completed",
      action: {
        type: "search", queries: ["TypeSafe Jev"],
        sources: [{ type: "url", url: "https://typesafe.ai/" }],
      },
    }],
  } as Parameters<typeof decodeTerminal>[0];

  assert.deepEqual(decodeTerminal(response).output, [{
    id: "ws_1", type: "web_search", status: "completed",
    action: {
      type: "search", queries: ["TypeSafe Jev"],
      sources: [{ type: "url", url: "https://typesafe.ai/" }],
    },
  }]);
});

test("accepts a streamed native web search before its action is available", () => {
  const response = {
    status: "completed",
    output: [{ id: "ws_pending", type: "web_search_call", status: "in_progress" }],
  } as unknown as Parameters<typeof decodeTerminal>[0];

  assert.deepEqual(decodeTerminal(response).output, [{
    id: "ws_pending", type: "web_search", status: "in_progress",
    action: { type: "search", queries: [] },
  }]);
});

test("encodes prior assistant text as Responses output content", () => {
  assert.deepEqual(toResponseInput([
    { type: "message", id: "user-1", role: "user", content: [{ type: "text", text: "hello" }] },
    { type: "message", id: "assistant-1", role: "assistant", content: [
      { type: "text", text: "Hello!" },
      { type: "refusal", reason: "Cannot do that." },
    ] },
  ]), [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    {
      type: "message", id: "assistant-1", role: "assistant", status: "completed",
      content: [
        { type: "output_text", text: "Hello!", annotations: [] },
        { type: "refusal", refusal: "Cannot do that." },
      ],
    },
  ]);
});

test("normalizes OpenAI URL annotations into numbered Markdown citations", () => {
  const text = "A current fact.";
  assert.equal(withMarkdownCitations(text, [{
    type: "url_citation",
    start_index: 2,
    end_index: text.length,
    title: "Source",
    url: "https://example.com/source",
  }]), "A current fact.[1](https://example.com/source)");
});

test("normalizes multiple OpenAI citations at the same marker without corrupting indexes", () => {
  const marker = "citesearch0search1";
  const text = `A current fact. ${marker}`;
  const start = text.indexOf(marker);
  const annotations = ["one", "two"].map((name) => ({
    type: "url_citation" as const,
    start_index: start,
    end_index: start + marker.length,
    title: name,
    url: `https://example.com/${name}`,
  }));

  assert.equal(
    withMarkdownCitations(text, annotations),
    "A current fact. [1](https://example.com/one)[2](https://example.com/two)",
  );
});

test("calls Brave with bounded results, freshness, domains, and the encrypted credential", async () => {
  const repository = new MemoryRepository();
  let requestedUrl: URL | undefined;
  let requestedHeaders: Headers | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ web: { results: [{
      title: "<b>Current result</b>", url: "https://example.com/article", description: "Useful &amp; recent", page_age: "2026-09-20",
    }] } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const service = new WebSearchService(repository, credentials, fetchImpl);
  await service.configure("owner", { enabled: true, apiKey: "secret-key" });

  const result = await service.search("owner", {
    query: "release notes", maxResults: 3, freshness: "week", domains: ["example.com"],
  });

  assert.equal(requestedUrl?.searchParams.get("q"), "release notes (site:example.com)");
  assert.equal(requestedUrl?.searchParams.get("count"), "3");
  assert.equal(requestedUrl?.searchParams.get("freshness"), "pw");
  assert.equal(requestedHeaders?.get("X-Subscription-Token"), "secret-key");
  assert.equal(result.citationFormat, "markdown-inline");
  assert.match(result.citationInstructions, /citationId/);
  assert.deepEqual(result.results[0], {
    citationId: 1, title: "Current result", url: "https://example.com/article", snippet: "Useful & recent", publishedAt: "2026-09-20",
  });
});

test("assigns contiguous citation ids after invalid Brave results are removed", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials, async () => (
    new Response(JSON.stringify({ web: { results: [
      { title: "Invalid", url: "javascript:alert(1)", description: "Ignored" },
      { title: "First", url: "https://example.com/first", description: "One" },
      { title: "Second", url: "https://example.com/second", description: "Two" },
    ] } }), { status: 200, headers: { "Content-Type": "application/json" } })
  ));
  await service.configure("owner", { enabled: true, apiKey: "secret-key" });

  const result = await service.search("owner", { query: "citations" });

  assert.deepEqual(result.results.map(({ citationId }) => citationId), [1, 2]);
});

test("calls Tavily with its API key in the JSON body and normalizes results", async () => {
  const repository = new MemoryRepository();
  let requestBody: Record<string, unknown> | undefined;
  const service = new WebSearchService(repository, credentials, async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ results: [{
      title: "Tavily result", url: "https://example.com/tavily", content: "Useful summary", published_date: "2026-09-21",
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await service.configure("owner", { enabled: true, provider: "tavily", apiKey: "tavily-key" });

  const result = await service.search("owner", { query: "release notes", domains: ["example.com"] });

  assert.equal(requestBody?.api_key, "tavily-key");
  assert.deepEqual(requestBody?.include_domains, ["example.com"]);
  assert.equal(result.provider, "tavily");
  assert.deepEqual(result.results[0], {
    citationId: 1, title: "Tavily result", url: "https://example.com/tavily", snippet: "Useful summary", publishedAt: "2026-09-21",
  });
});

test("does not reuse a credential after changing the external provider", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  await service.configure("owner", { enabled: true, provider: "brave", apiKey: "brave-key" });

  const settings = await service.configure("owner", { enabled: true, provider: "tavily" });

  assert.equal(settings.provider, "tavily");
  assert.equal(settings.hasCredential, false);
});

test("calls Serper with its API key header and normalizes Google results", async () => {
  const repository = new MemoryRepository();
  let requestedHeaders: Headers | undefined;
  const service = new WebSearchService(repository, credentials, async (_input, init) => {
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ organic: [{
      title: "Google result", link: "https://example.com/serper", snippet: "Useful snippet", date: "1 day ago",
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await service.configure("owner", { enabled: true, provider: "serper", apiKey: "serper-key" });

  const result = await service.search("owner", { query: "release notes" });

  assert.equal(requestedHeaders?.get("X-API-KEY"), "serper-key");
  assert.equal(result.provider, "serper");
  assert.equal(result.results[0]?.title, "Google result");
});

test("calls Bocha with Bearer authentication and normalizes Chinese search results", async () => {
  const repository = new MemoryRepository();
  let requestedHeaders: Headers | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const service = new WebSearchService(repository, credentials, async (_input, init) => {
    requestedHeaders = new Headers(init?.headers);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { webPages: { value: [{
      name: "博查结果", url: "https://example.cn/result", snippet: "网页摘要", summary: "更完整的摘要", datePublished: "2026-09-22T08:00:00+08:00",
    }] } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await service.configure("owner", { enabled: true, provider: "bocha", apiKey: "bocha-key" });

  const result = await service.search("owner", { query: "国内搜索", maxResults: 3, domains: ["example.cn"] });

  assert.equal(requestedHeaders?.get("Authorization"), "Bearer bocha-key");
  assert.equal(requestBody?.count, 3);
  assert.equal(requestBody?.include, "example.cn");
  assert.deepEqual(result.results[0], {
    citationId: 1, title: "博查结果", url: "https://example.cn/result", snippet: "更完整的摘要", publishedAt: "2026-09-22T08:00:00+08:00",
  });
});

test("maps authentication failures without exposing the response body", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials, async () => (
    new Response("secret diagnostic body", { status: 401 })
  ));
  await service.configure("owner", { enabled: true, apiKey: "bad-key" });

  await assert.rejects(() => service.search("owner", { query: "test" }), {
    message: "Brave Search rejected the API key.",
  });
});

test("clearing a forced-external credential also disables search", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  await service.configure("owner", { enabled: true, mode: "external", apiKey: "secret-key" });

  const view = await service.clearCredential("owner");
  assert.equal(view.enabled, false);
  assert.equal(view.hasCredential, false);
  await assert.rejects(() => service.search("owner", { query: "test" }), /disabled/);
});

test("clearing the Brave fallback keeps automatic native search enabled", async () => {
  const repository = new MemoryRepository();
  const service = new WebSearchService(repository, credentials);
  await service.configure("owner", { enabled: true, mode: "auto", apiKey: "secret-key" });

  const view = await service.clearCredential("owner");
  assert.equal(view.enabled, true);
  assert.equal(view.hasCredential, false);
});

test("allows testing a saved credential while agent web search is disabled", async () => {
  const repository = new MemoryRepository();
  let calls = 0;
  const service = new WebSearchService(repository, credentials, async () => {
    calls += 1;
    return new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await service.configure("owner", { enabled: false, apiKey: "secret-key" });

  await service.test("owner");
  assert.equal(calls, 1);
  await assert.rejects(() => service.search("owner", { query: "test" }), /disabled/);
});

test("migrates schema version 10 with external search provider settings", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT");
  database.prepare("INSERT INTO schema_metadata VALUES (1, ?, 10, ?)").run(SQLITE_SCHEMA_GENERATION, new Date().toISOString());

  runSqliteMigrations(database, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error("incompatible"));

  const version = database.prepare("SELECT version FROM schema_metadata WHERE id = 1").get() as { version: number };
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_search_settings'").get();
  database.prepare("INSERT INTO web_search_settings(owner_id, provider, enabled, base_url, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("owner", "brave", 0, "https://example.com", new Date().toISOString());
  const mode = database.prepare("SELECT mode FROM web_search_settings WHERE owner_id = ?").get("owner") as { mode: string };
  assert.equal(version.version, SQLITE_SCHEMA_VERSION);
  assert.ok(table);
  assert.equal(mode.mode, "auto");
  database.close();
});

test("round-trips an encrypted API key through the real SQLite repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "actl-web-search-"));
  const repository = new SqliteWorkspaceRepository(path.join(directory, "workspace.db"));
  const secretProtector = new SecretProtector(path.join(directory, "master-key.bin"));
  try {
    await repository.initialize();
    await secretProtector.initialize();
    let authorization = "";
    const service = new WebSearchService(repository, secretProtector, async (_input, init) => {
      authorization = new Headers(init?.headers).get("X-Subscription-Token") ?? "";
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const saved = await service.configure("owner", { enabled: true, apiKey: "persisted-secret" });
    assert.equal(saved.hasCredential, true);
    assert.equal(service.getSettings("owner").hasCredential, true);
    await service.search("owner", { query: "test" });
    assert.equal(authorization, "persisted-secret");
    const cleared = await service.clearCredential("owner");
    assert.equal(cleared.enabled, true);
    assert.equal(cleared.mode, "auto");
    assert.equal(cleared.hasCredential, false);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
