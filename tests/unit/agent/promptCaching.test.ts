import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createModelClient } from '../../../src/agent-core/model/client-factory';
import type { ModelProtocol, ModelTurnRequest } from '../../../src/agent-core/model/types';
import { materializeSelectedMcpReferences } from '../../../src/agent-core/mcp/model-context';
import { SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from '../../../src/agent-core/repositories/sqlite/initial-schema';
import { runSqliteMigrations } from '../../../src/agent-core/repositories/sqlite/migrations';
import { parseSqliteMessage } from '../../../src/agent-core/repositories/sqlite/run-payload-codec';

const request: ModelTurnRequest = {
  model: 'gpt-6.2-sol', instructions: 'Fixed rules',
  transcript: [{ type: 'message', id: 'user', role: 'user', content: [{ type: 'text', text: 'Task assigned by parent' }] }],
  tools: [], parallelToolCalls: false,
};

test('model drivers preserve the task’s user role and decode the providers’ cache usage', async (t) => {
  let requestBody: Record<string, any> = {};
  let events: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const invoke = (protocol: ModelProtocol, model = request.model) =>
    createModelClient({ model, baseURL: 'https://model.example/v1', apiKey: 'mock', protocol })
      .runTurn({ ...request, model }, () => {});

  events = [{ type: 'response.completed', response: { id: 'resp', output: [], status: 'completed', usage: {
    input_tokens: 2000, input_tokens_details: { cached_tokens: 1300, cache_write_tokens: 300 }, output_tokens: 40, total_tokens: 2040,
  } } }];
  assert.deepEqual((await invoke('responses')).usage,
    { inputTokens: 2000, cachedInputTokens: 1300, cacheWriteInputTokens: 300, outputTokens: 40, totalTokens: 2040 });
  assert.deepEqual(requestBody.input[0], { role: 'developer', content: 'Fixed rules' });
  assert.deepEqual(requestBody.input[1], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Task assigned by parent' }] });
  assert.equal(requestBody.instructions, undefined);

  events = [{ id: 'chat', choices: [], usage: {
    prompt_tokens: 2000, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 40, total_tokens: 2040,
  } }];
  assert.deepEqual((await invoke('chat_completions')).usage,
    { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 40, totalTokens: 2040 });
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'Fixed rules' }, { role: 'user', content: [{ type: 'text', text: 'Task assigned by parent' }] },
  ]);

  events = [
    { type: 'message_start', message: { id: 'msg', usage: { input_tokens: 400, cache_read_input_tokens: 1300, cache_creation_input_tokens: 300 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ];
  assert.deepEqual((await invoke('anthropic_messages', 'claude-opus-5-5')).usage,
    { inputTokens: 2000, cachedInputTokens: 1300, cacheWriteInputTokens: 300, outputTokens: 40, totalTokens: 2040 });
  assert.deepEqual(requestBody.system, [
    { type: 'text', text: 'Fixed rules', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(requestBody.messages, [{ role: 'user', content: [
    { type: 'text', text: 'Task assigned by parent', cache_control: { type: 'ephemeral' } },
  ] }]);
});

test('stored MCP selections replay their metadata and legacy references remain compact', () => {
  const selected = { id: 'mcp', type: 'message', role: 'user', content: [{ type: 'mcp_server', name: 'docs', selected: true }] };
  const reloaded = parseSqliteMessage(JSON.stringify(selected));
  const current = materializeSelectedMcpReferences([reloaded]);
  const history = materializeSelectedMcpReferences([reloaded, ...request.transcript]);
  assert.deepEqual(history[0], current[0]);
  assert.match(JSON.stringify(current), /selected_mcp_reference/);

  const olderInput = parseSqliteMessage(JSON.stringify({ ...selected, content: [{ type: 'mcp_server', name: 'docs' }] }));
  assert.deepEqual(materializeSelectedMcpReferences([olderInput]), [{ ...olderInput, content: [{ type: 'text', text: 'mcp:docs' }] }]);
});

test('the cache usage migration retains v28 rows with unknown cache counts', () => {
  using db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE schema_metadata(id INTEGER, generation TEXT, version INTEGER);
    CREATE TABLE model_invocation_usage(run_id TEXT, step INTEGER, input_tokens INTEGER);
    INSERT INTO model_invocation_usage VALUES ('old', 0, 1500);`);
  db.prepare('INSERT INTO schema_metadata VALUES (1, ?, 28)').run(SQLITE_SCHEMA_GENERATION);
  runSqliteMigrations(db, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new Error('Invalid schema'));
  assert.deepEqual({ ...db.prepare('SELECT * FROM model_invocation_usage').get() }, {
    run_id: 'old', step: 0, input_tokens: 1500, cached_input_tokens: null, cache_write_input_tokens: null,
  });
});
