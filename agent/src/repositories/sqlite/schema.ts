export const SQLITE_SCHEMA_GENERATION = "multi-user-multi-model";
export const SQLITE_SCHEMA_VERSION = 18;

export const INITIAL_SCHEMA_SQL = `
CREATE TABLE schema_metadata(id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), created_at TEXT NOT NULL) STRICT;
CREATE TABLE projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX projects_owner_cwd_idx ON projects(owner_id, cwd);
CREATE TABLE sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE agent_runs(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_order INTEGER NOT NULL, status TEXT NOT NULL, model_snapshot_json TEXT NOT NULL,
  permission_snapshot_json TEXT NOT NULL DEFAULT '{"permissionMode":"ask"}',
  pending_tool_batch_json TEXT, error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  next_sequence_number INTEGER NOT NULL, UNIQUE(session_id, run_order)
) STRICT;
CREATE INDEX agent_runs_session_idx ON agent_runs(session_id, run_order);
CREATE TABLE run_messages(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, message_order INTEGER NOT NULL, message_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, message_order)) STRICT;
CREATE TABLE run_skills(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, skill_order INTEGER NOT NULL, skill_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(run_id, skill_order)) STRICT;
CREATE TABLE timeline_items(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, item_order INTEGER NOT NULL, item_id TEXT NOT NULL, item_type TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id, item_order)) STRICT;
CREATE TABLE provider_response_ids(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, response_order INTEGER NOT NULL, provider_response_id TEXT NOT NULL, PRIMARY KEY(run_id, response_order)) STRICT;
CREATE TABLE session_context_states(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, summary TEXT NOT NULL, summarized_run_count INTEGER NOT NULL CHECK(summarized_run_count >= 0), last_input_tokens INTEGER, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE context_compressions(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, summarized_run_count INTEGER NOT NULL CHECK(summarized_run_count > 0), summary TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(session_id, summarized_run_count)) STRICT;
CREATE TABLE model_invocation_usage(run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, step INTEGER NOT NULL CHECK(step >= 0), input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(run_id, step)) STRICT;
CREATE TABLE file_changes(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, file_path TEXT NOT NULL, change_type TEXT NOT NULL, summary TEXT NOT NULL, diff TEXT, new_content TEXT, old_content TEXT, created_at TEXT NOT NULL) STRICT;
CREATE INDEX file_changes_session_idx ON file_changes(session_id, created_at);
CREATE TABLE stored_files(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, filename TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0), sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE INDEX stored_files_session_idx ON stored_files(session_id, created_at);
CREATE TABLE file_bindings(
  file_id TEXT NOT NULL REFERENCES stored_files(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL, file_order INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, message_id, file_order), UNIQUE(run_id, message_id, file_id)
) STRICT;
CREATE INDEX file_bindings_file_idx ON file_bindings(file_id);
CREATE TABLE provider_accounts(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), current_version INTEGER NOT NULL CHECK(current_version > 0), deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE INDEX provider_accounts_owner_idx ON provider_accounts(owner_id, deleted_at, created_at);
CREATE TABLE provider_account_versions(account_id TEXT NOT NULL REFERENCES provider_accounts(id), version INTEGER NOT NULL, base_url TEXT, config_json TEXT NOT NULL, credential_version INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(account_id, version)) STRICT;
CREATE TABLE provider_credentials(account_id TEXT NOT NULL REFERENCES provider_accounts(id), version INTEGER NOT NULL, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL, key_version INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(account_id, version)) STRICT;
CREATE TABLE user_model_targets(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES provider_accounts(id),
  provider_model TEXT NOT NULL, display_name TEXT NOT NULL, protocol TEXT NOT NULL, capabilities_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(account_id, provider_model, protocol)
) STRICT;
CREATE INDEX user_model_targets_owner_idx ON user_model_targets(owner_id, enabled, created_at);
CREATE TABLE user_model_preferences(owner_id TEXT PRIMARY KEY, selected_model_target_id TEXT, reasoning_effort TEXT, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE web_search_settings(
  owner_id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('brave', 'tavily', 'serper', 'bocha')), mode TEXT NOT NULL DEFAULT 'auto' CHECK(mode IN ('auto', 'native', 'external')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)), base_url TEXT NOT NULL,
  ciphertext BLOB, nonce BLOB, auth_tag BLOB, key_version INTEGER,
  updated_at TEXT NOT NULL,
  CHECK((ciphertext IS NULL AND nonce IS NULL AND auth_tag IS NULL AND key_version IS NULL) OR
        (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL AND key_version IS NOT NULL))
) STRICT;
CREATE TABLE prompt_settings(
  owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
  blocks_json TEXT NOT NULL CHECK(json_valid(blocks_json)), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE mcp_servers(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL, key_version INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT;
`;
