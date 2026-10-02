import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { McpToolProvider } from "../src/mcp/mcp-tool-provider.js";
import { McpServerManager } from "../src/mcp/mcp-server-manager.js";
import { createSilentLogger } from "../src/observability/logger.js";
import { SqliteWorkspaceRepository } from "../src/repositories/sqlite-workspace-repository.js";
import { runSqliteMigrations } from "../src/repositories/sqlite/migrations/index.js";
import { SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from "../src/repositories/sqlite/schema.js";
import { SecretProtector } from "../src/security/secret-protector.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RunPermissionEngine } from "../src/permissions/run-policy.js";
import { PromptCompiler } from "../src/runtime/prompt-compiler.js";
import { materializeSelectedMcpReferences } from "../src/mcp/model-context.js";
import type { Session } from "../src/runtime/workspace-store.js";
import { createMcpRoutes } from "../src/http/mcp/mcp.routes.js";
import { createApiErrorHandler } from "../src/http/common/api-error.js";
import { createResponseBodySchema } from "../src/http/sessions/session.schemas.js";
import { inputFromDto } from "../src/http/agent-responses/presenter.js";

test("MCP stdio server is discovered, approved, called, and closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-mcp-"));
  const fixture = fileURLToPath(new URL("./fixtures/add-mcp-server.mjs", import.meta.url));
  let provider: McpToolProvider | undefined;
  try {
    provider = new McpToolProvider("math", { command: process.execPath, args: [fixture], enabled: true }, directory, createSilentLogger());
    const registry = new ToolRegistry();
    registry.registerProvider(provider);
    const [tool] = await registry.listTools();
    assert.equal(tool?.name, "mcp__math__add");
    assert.deepEqual(Object.keys(tool?.inputSchema.properties as object), ["a", "b"]);
    const call = { id: "test-call", name: tool!.name, input: { a: 1, b: 2 } };
    const requirement = await registry.getPermissionRequirement(call);
    assert.equal(requirement?.capability, "mcp.math");
    assert.match(requirement?.resource ?? "", /^add@[0-9a-f-]+$/);
    assert.equal(requirement?.action, "execute");
    assert.equal((await new RunPermissionEngine().decide(call, requirement!, { snapshot: { permissionMode: "ask" } })).type, "ask");
    const result = await registry.callTool(call, { cwd: directory, authorization: { requirement: requirement!, approvedByUser: true } });
    assert.equal(result.ok, true);
    assert.deepEqual((result.output as { content: unknown[] }).content, [{ type: "text", text: "3" }]);
    const invalid = await registry.callTool({ ...call, input: { a: "x", b: 2 } }, { cwd: directory, authorization: { requirement: requirement!, approvedByUser: true } });
    assert.equal(invalid.ok, false);
    const denied = await registry.callTool(call, { cwd: directory });
    assert.equal(denied.ok, false);
  } finally {
    await provider?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP HTTP configuration API applies changes and reports connection errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-mcp-http-"));
  const fixture = fileURLToPath(new URL("./fixtures/add-mcp-server.mjs", import.meta.url));
  const repository = new SqliteWorkspaceRepository(path.join(directory, "workspace.db"));
  await repository.initialize();
  const secrets = new SecretProtector(path.join(directory, "key.bin"));
  await secrets.initialize();
  const manager = new McpServerManager(directory, repository, secrets, createSilentLogger());
  await manager.initialize();
  const app = express();
  app.use(express.json());
  app.use("/mcp", createMcpRoutes(manager));
  app.use(createApiErrorHandler());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  try {
    const config = { command: process.execPath, args: [fixture], enabled: true };
    const saved = await fetch(`${url}/servers/math`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).tools[0].name, "mcp__math__add");
    const listed = await fetch(`${url}/servers`);
    assert.equal((await listed.json()).servers[0].connected, true);
    const catalog = await fetch(`${url}/catalog`);
    assert.deepEqual(await catalog.json(), { servers: [{ name: "math", connected: true, toolCount: 1 }] });
    const failed = await fetch(`${url}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "broken", config: { command: path.join(directory, "missing.exe"), args: [], enabled: true } }) });
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).error.code, "mcp_connection_failed");
    const removed = await fetch(`${url}/servers/math`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal(manager.listServers().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP server changes apply without restarting the agent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-mcp-manager-"));
  const fixture = fileURLToPath(new URL("./fixtures/add-mcp-server.mjs", import.meta.url));
  const repository = new SqliteWorkspaceRepository(path.join(directory, "workspace.db"));
  await repository.initialize();
  const secrets = new SecretProtector(path.join(directory, "key.bin"));
  await secrets.initialize();
  const manager = new McpServerManager(directory, repository, secrets, createSilentLogger());
  const registry = new ToolRegistry();
  registry.registerProvider(manager);
  const session: Session = { id: "mcp-test", ownerId: "test", projectId: null, created_at: "", updated_at: "", cwd: null, runs: [], fileChanges: [], compressionRecords: [] };
  const search = async (input: Record<string, unknown> = {}) => {
    const call = { id: "search", name: "search_mcp_tools", input };
    const requirement = await registry.getPermissionRequirement(call);
    assert.equal(requirement?.action, "list");
    const result = await registry.callTool(call, { cwd: directory, authorization: { requirement: requirement!, approvedByUser: false } });
    assert.equal(result.ok, true);
    return result.output as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }>; total: number };
  };
  try {
    await manager.initialize();
    const toolNames = (await registry.listTools()).map((tool) => tool.name);
    assert.deepEqual(toolNames, ["search_mcp_tools", "call_mcp_tool"]);
    assert.equal((await search()).total, 0);
    const config = { command: process.execPath, args: [fixture], enabled: true };
    assert.equal((await manager.testServer("math", config)).tools.length, 1);
    await manager.saveServer("math", config);
    assert.equal(manager.listServers()[0]?.connected, true);
    assert.deepEqual((await registry.listTools()).map((tool) => tool.name), toolNames);
    const discovered = await search({ server: "math", query: "add" });
    assert.equal(discovered.tools[0]?.name, "mcp__math__add");
    assert.deepEqual(Object.keys(discovered.tools[0]?.inputSchema.properties as object), ["a", "b"]);
    const call = { id: "manager-call", name: "call_mcp_tool", input: { toolName: "mcp__math__add", arguments: { a: 2, b: 3 } } };
    const firstApproval = await registry.getPermissionRequirement(call);
    assert.equal(firstApproval?.capability, "mcp.math");
    assert.equal((await registry.callTool(call, { cwd: directory, authorization: { requirement: firstApproval!, approvedByUser: true } })).ok, true);
    await manager.saveServer("math", { ...config, enabled: false });
    assert.deepEqual((await registry.listTools()).map((tool) => tool.name), toolNames);
    assert.equal((await search()).total, 0);
    assert.equal((await registry.callTool(call, { cwd: directory, authorization: { requirement: firstApproval!, approvedByUser: true } })).ok, false);
    assert.equal(serverConfigFromRepository(repository, secrets, "math")?.enabled, false);
    await manager.saveServer("math", config);
    assert.equal((await search()).total, 1);
    const staleApproval = await registry.callTool(call, { cwd: directory, authorization: { requirement: firstApproval!, approvedByUser: true } });
    assert.equal(staleApproval.ok, false);
    await manager.deleteServer("math");
    assert.deepEqual((await registry.listTools()).map((tool) => tool.name), toolNames);
    assert.deepEqual(repository.listMcpServers(), []);
    const prompt = await new PromptCompiler().compile(session, []);
    assert.doesNotMatch(prompt.instructions, /mcp__math__add|MCP TOOLS IN THIS REQUEST/);
    assert.equal(prompt.transcript.length, 0);
  } finally {
    await manager.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function serverConfigFromRepository(repository: SqliteWorkspaceRepository, secrets: SecretProtector, name: string): { enabled: boolean } | undefined {
  const stored = repository.listMcpServers().find((server) => server.name === name);
  return stored ? JSON.parse(secrets.decrypt(stored.credential)) as { enabled: boolean } : undefined;
}

test("only current user MCP selections get a reference block", async () => {
  const session: Session = { id: "mcp-history", ownerId: "test", projectId: null, created_at: "", updated_at: "", cwd: null, runs: [], fileChanges: [], compressionRecords: [] };
  const history = [{
    type: "message" as const,
    id: "old-question",
    role: "user" as const,
    content: [{ type: "mcp_server" as const, name: "old" }],
  }, {
    type: "message" as const,
    id: "new-question",
    role: "user" as const,
    content: [{ type: "text" as const, text: "Add two numbers" }, { type: "mcp_server" as const, name: "math" }],
  }];
  const materialized = materializeSelectedMcpReferences(history, [history[1]], ["math"]);
  const prompt = await new PromptCompiler().compile(session, materialized);
  assert.equal(history.length, 2);
  assert.deepEqual(prompt.transcript.map((item) => item.type === "message" ? item.role : "other"), ["user", "user"]);
  assert.doesNotMatch(JSON.stringify(prompt.transcript[0]), /selected_mcp_reference/);
  assert.match(JSON.stringify(prompt.transcript[1]), /selected_mcp_reference/);
  const currentText = prompt.transcript[1].type === "message"
    ? prompt.transcript[1].content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
    : "";
  assert.match(currentText, /"server":"math"/);
  assert.equal(history[1].content[1].type, "mcp_server");
});

test("MCP references pass through the response input protocol", () => {
  const body = createResponseBodySchema.parse({
    model: "test-model",
    input: [{ type: "message", role: "user", content: [
      { type: "input_text", text: "Add two numbers" },
      { type: "input_mcp_server", name: "math" },
    ] }],
  });
  assert.deepEqual(inputFromDto(body.input)[0]?.content[1], { type: "mcp_server", name: "math" });
});

test("MCP configuration persists encrypted across manager restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-mcp-persist-"));
  const repository = new SqliteWorkspaceRepository(path.join(directory, "workspace.db"));
  await repository.initialize();
  const secrets = new SecretProtector(path.join(directory, "key.bin"));
  await secrets.initialize();
  const manager = new McpServerManager(directory, repository, secrets, createSilentLogger());
  const fixture = fileURLToPath(new URL("./fixtures/add-mcp-server.mjs", import.meta.url));
  try {
    await manager.initialize();
    await manager.saveServer("math", { command: process.execPath, args: [fixture], env: { TOKEN: "secret-value" }, enabled: false });
    assert.equal(serverConfigFromRepository(repository, secrets, "math")?.enabled, false);
    assert.equal(repository.listMcpServers()[0]?.credential.ciphertext.includes(Buffer.from("secret-value")), false);
    const restarted = new McpServerManager(directory, repository, secrets, createSilentLogger());
    try {
      await restarted.initialize();
      assert.equal(restarted.listServers()[0]?.config.env?.TOKEN, "secret-value");
    } finally {
      await restarted.close();
    }
  } finally {
    await manager.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing schema v15 upgrades to MCP storage", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL)");
    database.prepare("INSERT INTO schema_metadata(id, generation, version) VALUES (1, ?, 15)").run(SQLITE_SCHEMA_GENERATION);
    runSqliteMigrations(database, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error("incompatible"));
    assert.equal((database.prepare("SELECT version FROM schema_metadata WHERE id = 1").get() as { version: number }).version, SQLITE_SCHEMA_VERSION);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_servers'").get());
  } finally {
    database.close();
  }
});

test("schema v16 removes the import marker without losing MCP servers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY, generation TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE mcp_servers(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL, key_version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE mcp_import_state(id INTEGER PRIMARY KEY, imported INTEGER NOT NULL);
      INSERT INTO mcp_import_state VALUES (1, 1);
    `);
    database.prepare("INSERT INTO schema_metadata(id, generation, version) VALUES (1, ?, 16)").run(SQLITE_SCHEMA_GENERATION);
    database.prepare("INSERT INTO mcp_servers VALUES (?, ?, ?, ?, ?, ?)").run("math", Buffer.from("encrypted"), Buffer.alloc(12), Buffer.alloc(16), 1, "now");
    runSqliteMigrations(database, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error("incompatible"));
    assert.ok(database.prepare("SELECT name FROM mcp_servers WHERE name = 'math'").get());
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'mcp_import_state'").get(), undefined);
  } finally {
    database.close();
  }
});

test("official filesystem MCP server reads and writes inside its allowed directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-mcp-filesystem-"));
  const server = fileURLToPath(new URL("../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", import.meta.url));
  const provider = new McpToolProvider("filesystem_test", { command: process.execPath, args: [server, directory] }, directory, createSilentLogger());
  const registry = new ToolRegistry();
  registry.registerProvider(provider);
  try {
    const tools = await registry.listTools();
    const writeTool = tools.find((tool) => tool.name === "mcp__filesystem_test__write_file");
    const readTool = tools.find((tool) => tool.name === "mcp__filesystem_test__read_text_file");
    assert.ok(writeTool);
    assert.ok(readTool);
    const target = path.join(directory, "hello.txt");
    const writeCall = { id: "write-test", name: writeTool.name, input: { path: target, content: "Actl MCP works" } };
    const writeRequirement = await registry.getPermissionRequirement(writeCall);
    assert.equal((await new RunPermissionEngine().decide(writeCall, writeRequirement!, { snapshot: { permissionMode: "ask" } })).type, "ask");
    const writeResult = await registry.callTool(writeCall, { cwd: directory, authorization: { requirement: writeRequirement!, approvedByUser: true } });
    assert.equal(writeResult.ok, true);
    assert.equal(await readFile(target, "utf8"), "Actl MCP works");
    const readCall = { id: "read-test", name: readTool.name, input: { path: target } };
    const readRequirement = await registry.getPermissionRequirement(readCall);
    const readResult = await registry.callTool(readCall, { cwd: directory, authorization: { requirement: readRequirement!, approvedByUser: true } });
    assert.equal(readResult.ok, true);
    assert.match(JSON.stringify(readResult.output), /Actl MCP works/);
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
