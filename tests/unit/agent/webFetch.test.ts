import assert from "node:assert/strict";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import iconv from "iconv-lite";
import { Agent, MockAgent } from "undici";
import { WebFetchToolProvider } from "../../../src/agent-core/tools/builtin/web-fetch.js";
import { ToolRegistry } from "../../../src/agent-core/tools/registry.js";
import { fetchPage, parsePageUrl } from "../../../src/agent-core/web-fetch/fetch-service.js";
import { extractPage } from "../../../src/agent-core/web-fetch/page-content.js";

test("blocks local addresses, alternate IP spellings, URL credentials and file URLs", () => {
  for (const url of [
    "http://127.1/", "http://0x7f000001/", "http://169.254.169.254/",
    "http://[::ffff:192.168.1.2]/", "http://[fe80::1]/", "http://localhost/",
  ]) {
    assert.throws(() => parsePageUrl(url), /blocked_address/);
  }
  for (const url of ["file:///C:/Windows", "https://user:secret@example.com"]) {
    assert.throws(() => parsePageUrl(url), /invalid_url/);
  }
});

test("rejects DNS answers that mix public and private IP addresses at connect time", async (t) => {
  const lookup = t.mock.method(dns, "lookup", (_hostname, options, callback) => {
    assert.equal(options.all, true);
    callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(fetchPage("http://mixed.example", 1_000), /blocked_address/);
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    lookup.mock.restore();
    syncBuiltinESMExports();
  }
});

test("fetches same-domain redirects through the registry and stops at other domains", async (t) => {
  const mockTransport = new Agent();
  mockTransport.dispatch = mockTransport.dispatch.bind(mockTransport);
  const server = new MockAgent({ agent: mockTransport });
  server.disableNetConnect();
  t.mock.method(Agent.prototype, "dispatch", server.dispatch.bind(server));
  t.after(() => server.close());

  const host = server.get("https://example.com");
  host.intercept({ path: "/start" }).reply(302, "", { headers: { location: "/article" } });
  host.intercept({ path: "/article" }).reply(200, "<main><p>Article text.</p></main>", {
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
  host.intercept({ path: "/external" }).reply(302, "", { headers: { location: "https://other.example/article" } });
  host.intercept({ path: "/local" }).reply(302, "", { headers: { location: "http://127.0.0.1/" } });
  host.intercept({ path: "/big" }).reply(200, gzipSync("x".repeat(2 * 1024 * 1024 + 1)), {
    headers: { "content-type": "text/plain", "content-encoding": "gzip" },
  });
  host.intercept({ path: "/pdf" }).reply(200, "", { headers: { "content-type": "application/pdf" } });

  const registry = new ToolRegistry();
  registry.registerProvider(new WebFetchToolProvider());
  const call = { id: "fetch", name: "web_fetch", input: { url: "https://example.com/start" } };
  const requirement = await registry.getPermissionRequirement(call);
  assert.deepEqual(requirement, { capability: "network.fetch", resource: "example.com", action: "read" });
  assert.equal((await registry.callTool(call)).ok, false);
  assert.deepEqual((await registry.callTool(call, {
    cwd: null, authorization: { requirement: requirement!, approvedByUser: false },
  })).output, {
    requestedUrl: "https://example.com/start", finalUrl: "https://example.com/article",
    contentType: "text/html; charset=UTF-8", title: null, content: "Article text.", truncated: false,
  });
  await assert.rejects(fetchPage("https://example.com/external", 1_000), /cross_domain_redirect.*other\.example/);
  await assert.rejects(fetchPage("https://example.com/local", 1_000), /blocked_address/);
  await assert.rejects(fetchPage("https://example.com/big", 1_000), /response_too_large/);
  await assert.rejects(fetchPage("https://example.com/pdf", 1_000), /unsupported_content_type/);
  server.assertNoPendingInterceptors();
});

test("decodes legacy HTML and preserves document links, code and tables", () => {
  const html = `<title>文档</title><base href="https://other.example/"><main>
    <h1>中文文档</h1><nav>Navigation</nav><script>throw Error("Script ran")</script>
    <p><a href="/guide">Guide</a> <a href="javascript:alert(1)">Unsafe link</a></p>
    <pre>const x = 1;</pre><table><tr><td>Key</td><td>Value</td></tr><tr><td>x</td><td>1</td></tr></table>
  </main>`;
  const result = extractPage(iconv.encode(html, "gbk"), new URL("https://example.com/doc"), "text/html; charset=gbk", "text/html", 1_000);
  assert.equal(result.title, "文档");
  assert.match(result.content, /# 中文文档/);
  assert.match(result.content, /\[Guide\]\(https:\/\/example\.com\/guide\)/);
  assert.match(result.content, /```\nconst x = 1;\n```/);
  assert.match(result.content, /\| Key \| Value \|\n\| --- \| --- \|\n\| x \| 1 \|/);
  assert.doesNotMatch(result.content, /Navigation|Script ran|javascript:|<table/);
});

test("truncates Markdown before an oversized code block", () => {
  const html = `<main><h1>Documentation</h1><pre>${"x".repeat(2_000)}</pre></main>`;
  assert.deepEqual(extractPage(Buffer.from(html), new URL("https://example.com"), "text/html", "text/html", 1_000), {
    title: null, content: "# Documentation", truncated: true,
  });
});
