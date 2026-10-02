import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TEXT_TOOL_CAPABILITIES, type ModelCapabilities, type ModelExecutionSnapshot } from "../src/model/catalog-types.js";
import { findModelCompatibilityIssues } from "../src/model/compatibility.js";
import { toResponseInput } from "../src/model/protocols/responses/encoder.js";
import { toChatMessages } from "../src/model/protocols/chat-completions/encoder.js";
import { toAnthropicRequest } from "../src/model/protocols/anthropic-messages/encoder.js";
import { projectToolResultImages } from "../src/model/tool-result-media.js";
import type { ModelTurnRequest, TranscriptItem, TranscriptMessage } from "../src/model/types.js";
import { SqliteWorkspaceRepository } from "../src/repositories/sqlite-workspace-repository.js";
import { StoredFileService, MAX_STORED_FILE_BYTES } from "../src/stored-files/stored-file-service.js";
import { ReadImageToolProvider } from "../src/tools/builtin/read-image.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { WorkspaceStore } from "../src/runtime/workspace-store.js";
import { AgentLoop } from "../src/runtime/agent-loop/agent-loop.js";
import type { ModelStore } from "../src/runtime/model-store.js";
import { RunPermissionEngine } from "../src/permissions/engine.js";
import { InMemoryHookEventBus } from "../src/hooks/event-bus.js";
import { createModelHandlers } from "../src/http/models/model.handlers.js";
import { toAgentItemDto } from "../src/http/agent-responses/presenter.js";
import type { Response } from "express";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
const vision: ModelCapabilities = { ...TEXT_TOOL_CAPABILITIES, input: { text: true, imageMimeTypes: ["image/png"], audioMimeTypes: [] } };
const text = TEXT_TOOL_CAPABILITIES;
function snapshot(capabilities: ModelCapabilities): ModelExecutionSnapshot {
  return { targetId: capabilities === text ? "text" : "vision", displayName: "test", providerModel: "test",
    accountId: "account", accountVersion: 1, credentialVersion: 1, baseURL: "https://example.com", protocol: "responses", capabilities };
}
const message = (id: string, content: TranscriptMessage["content"]): TranscriptMessage => ({ type: "message", id, role: "user", content });
const call = (id: string): Extract<TranscriptItem, { type: "tool_call" }> => ({ type: "tool_call", id, callId: id, name: "read_image", argumentsJson: '{"path":"image.dat"}' });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actl-images-"));
  const repository = new SqliteWorkspaceRepository(path.join(directory, "workspace.db"));
  const workspace = new WorkspaceStore(repository);
  await workspace.initialize();
  const project = await workspace.createProject("owner", directory);
  const session = await workspace.createSession("owner", { projectId: project.id });
  const files = new StoredFileService(directory, repository);
  await files.initialize();
  const registry = new ToolRegistry();
  registry.registerProvider(new ReadImageToolProvider(files));
  await writeFile(path.join(directory, "image.dat"), png);
  return { directory, repository, workspace, session, files, registry,
    async close() { repository.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("read_image respects capabilities, canonical path authorization, signatures and size limits", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.registry.listTools(text)).length, 0);
    assert.equal((await f.registry.listTools(vision))[0]?.name, "read_image");
    const request = { id: "read", name: "read_image", input: { path: "image.dat" } };
    const base = { cwd: f.directory, sessionId: f.session.id, modelCapabilities: vision };
    const requirement = (await f.registry.getPermissionRequirement(request, base))!;
    const context = { ...base, authorization: { requirement, approvedByUser: false } };
    assert.equal((await f.registry.callTool(request, base)).ok, false);
    assert.equal((await f.registry.callTool(request, { ...context, modelCapabilities: text })).ok, false);
    assert.equal((await f.registry.callTool(request, { ...context, authorization: { requirement: { ...requirement, resource: path.join(f.directory, "other") }, approvedByUser: true } })).ok, false);
    const result = await f.registry.callTool(request, context);
    assert.equal(result.ok, true);
    assert.equal((result.output as { media_type: string }).media_type, "image/png");
    assert.equal(result.content?.[0]?.type, "stored_file");
    assert.ok(!JSON.stringify(result).includes(png.toString("base64")));
    const fileId = (result.output as { file_id: string }).file_id;
    const history = [message("image", [{ type: "stored_file", fileId }])];
    await writeFile(path.join(f.directory, "image.dat"), "changed");
    const projected = await f.files.materializeTranscript(f.session.id, history, vision);
    assert.equal((projected[0] as TranscriptMessage).content[0]?.type, "image");
    assert.ok(JSON.stringify(projected).includes(png.toString("base64")));
    assert.equal((await f.registry.callTool(request, context)).ok, false);
    await writeFile(path.join(f.directory, "image.dat"), png);
    assert.equal((await f.registry.callTool(request, { ...context, modelCapabilities: { ...vision, input: { ...vision.input, imageMimeTypes: ["image/jpeg"] } } })).ok, false);
    await writeFile(path.join(f.directory, "image.dat"), Buffer.alloc(MAX_STORED_FILE_BYTES + 1));
    assert.equal((await f.registry.callTool(request, context)).ok, false);
    const other = await f.workspace.createSession("owner");
    await assert.rejects(() => f.files.materializeTranscript(other.id, history), /does not belong/);
  } finally { await f.close(); }
});

test("image tool results preserve batch ordering in all three protocol encoders", () => {
  const image = { type: "image" as const, source: { type: "data" as const, data: png.toString("base64"), mediaType: "image/png" } };
  const transcript: TranscriptItem[] = [call("a"), call("b"),
    { type: "tool_result", id: "ra", callId: "a", isError: false, content: [image] },
    { type: "tool_result", id: "rb", callId: "b", isError: false, content: [{ type: "text", text: "done" }, image] }];
  const before = structuredClone(transcript);
  assert.deepEqual(projectToolResultImages(transcript).map((item) => item.type), ["tool_call", "tool_call", "tool_result", "tool_result", "message", "message"]);
  const response = toResponseInput(transcript) as Array<Record<string, any>>;
  assert.deepEqual(response.map((item) => item.type), ["function_call", "function_call", "function_call_output", "function_call_output", "message", "message"]);
  assert.equal(response[4]?.content[1].type, "input_image");
  const chat = toChatMessages("", transcript) as Array<Record<string, any>>;
  assert.deepEqual(chat.map((item) => item.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(chat[3]?.content[1].type, "image_url");
  const request: ModelTurnRequest = { model: "test", instructions: "", transcript, tools: [], parallelToolCalls: true };
  const anthropic = toAnthropicRequest(request).messages as Array<Record<string, any>>;
  assert.equal(anthropic[1]?.content[0].type, "tool_result");
  assert.equal(anthropic[1]?.content[1].type, "tool_result");
  assert.equal(anthropic[2]?.content[1].type, "image");
  assert.deepEqual(transcript, before);
  assert.deepEqual(findModelCompatibilityIssues(transcript, text), ["image:image/png"]);
  assert.deepEqual(findModelCompatibilityIssues(transcript, vision), []);
});

test("a session switches vision to text and back, rejects new text-model images, and retains snapshots after restart", async () => {
  const f = await fixture();
  try {
    const requests: ModelTurnRequest[] = [];
    let nextCall = true;
    const router = {
      async resolveSnapshot(_owner: string, id: string) { return snapshot(id === "text" ? text : vision); },
      async getClientForSnapshot() { return { async runTurn(request: ModelTurnRequest) {
        requests.push(structuredClone(request));
        if (nextCall) { nextCall = false; return { finishReason: "tool_calls", output: [call(`call_${requests.length}`)] }; }
        return { finishReason: "stop", output: [{ type: "message", id: `answer_${requests.length}`, role: "assistant", content: [{ type: "text", text: "Previous model description" }] }] };
      } }; },
    } as unknown as ModelStore;
    const loop = new AgentLoop(router, f.registry, new RunPermissionEngine(), new InMemoryHookEventBus(), f.workspace, f.files);
    const run = (id: string, input = [message(`input_${requests.length}`, [{ type: "text", text: "continue" }])]) =>
      loop.run(f.session, input, { model: id, permissionMode: "full_access" });
    assert.equal((await run("vision")).status, "completed");
    assert.ok(JSON.stringify(requests.at(-1)?.transcript).includes(png.toString("base64")));
    const history = structuredClone(f.workspace.getModelContext(f.session));
    const fileId = f.repository.listStoredFiles(f.session.id)[0]!.id;
    await rm(path.join(f.directory, "image.dat"));
    assert.equal((await run("text")).status, "completed");
    assert.equal(requests.at(-1)?.tools.some((tool) => tool.name === "read_image"), false);
    assert.ok(!JSON.stringify(requests.at(-1)?.transcript).includes(png.toString("base64")));
    assert.match(JSON.stringify(requests.at(-1)?.transcript), /image pixels were not provided/);
    assert.equal((await run("vision")).status, "completed");
    assert.ok(JSON.stringify(requests.at(-1)?.transcript).includes(png.toString("base64")));
    const count = requests.length;
    await assert.rejects(() => run("text", [message("new_image", [{ type: "stored_file", fileId }])]), /does not support/);
    assert.equal(requests.length, count);
    // A text model imitating an old call receives an error before filesystem access.
    nextCall = true;
    assert.equal((await run("text")).status, "completed");
    assert.match(JSON.stringify(requests.at(-1)?.transcript), /unavailable for the current model/);
    assert.deepEqual(f.workspace.getModelContext(f.session).slice(0, history.length), history);
    const resultItem = f.session.runs[0]!.timeline.find((item) => item.type === "tool_result")!;
    const dto = toAgentItemDto(resultItem, "completed");
    assert.equal(dto.type, "function_call_output");
    if (dto.type === "function_call_output") {
      assert.equal(JSON.parse(dto.output).ok, true);
      assert.equal(dto.content?.[0]?.type, "stored_file");
    }
    let catalog: any;
    const catalogRouter = { async list() { return { data: [{ id: "text", capabilities: text }, { id: "vision", capabilities: vision }] }; } } as unknown as ModelStore;
    const response = { locals: { ownerId: "owner", validated: { query: { sessionId: f.session.id } } }, json(value: unknown) { catalog = value; } } as unknown as Response;
    await createModelHandlers(catalogRouter, f.workspace, f.files).listModels({}, response);
    assert.ok(catalog.data.every((model: any) => model.compatible));
    await f.repository.deleteExpiredUnboundFiles("9999-01-01T00:00:00.000Z");
    assert.ok(f.repository.getStoredFile(fileId));
    f.repository.close();
    await f.repository.initialize();
    const stored = await f.repository.loadSessionContent(f.session.id);
    assert.ok(stored.runs.some((run) => run.timeline.some((item) => item.type === "tool_result" && item.content.some((part) => part.type === "stored_file"))));
    await f.files.initialize();
    const replay = await f.files.materializeTranscript(f.session.id, history, vision);
    assert.ok(JSON.stringify(replay).includes(png.toString("base64")));
    assert.equal(await loop.compact(f.session, "text"), true);
    assert.ok(!JSON.stringify(requests.at(-1)?.transcript).includes(png.toString("base64")));
    assert.match(JSON.stringify(requests.at(-1)?.transcript), /image pixels were not provided/);
  } finally { await f.close(); }
});
