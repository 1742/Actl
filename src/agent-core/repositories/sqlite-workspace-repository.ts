import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentRunRecord } from "../runtime/agent-domain.js";
import type {
  FileChangeRecord,
  ContextCompressionRecord,
  ModelInvocationUsageRecord,
  ProjectRecord,
  SessionContentRecord,
  SessionContextStateRecord,
  SessionMetadataRecord,
  StoredFileRecord,
  StoredFileRepository,
  TimelineItemUpdate,
  WorkspaceIndex,
  WorkspaceRepository,
} from "./workspace-repository.js";
import {
  parseSqliteMessage,
  parseSqlitePendingBatch,
  parseSqliteTimelineItem,
} from "./sqlite-session-codec.js";
import { nowIso } from "../utils.js";
import type { ModelCatalogRepository, CreateProviderAccountRecord, ModelPreferenceRecord } from "./model-catalog-repository.js";
import type { ProviderAccountRecord, ModelTargetRecord } from "../model/catalog-types.js";
import type { EncryptedSecret } from "../security/encrypted-secret.js";
import { SqliteModelCatalogStore } from "./sqlite/model-catalog-store.js";
import { SqliteStoredFileStore } from "./sqlite/stored-file-store.js";
import { runSqliteMigrations } from "./sqlite/migrations/index.js";
import {
  assertChanged, bufferColumn, nullableNumberColumn, nullableStringColumn, numberColumn, parseModelSnapshot, parsePermissionSnapshot, stringColumn,
  toFileChange, toProject, toSessionMetadata,
} from "./sqlite/row-codec.js";
import { INITIAL_SCHEMA_SQL, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION } from "./sqlite/schema.js";
import type { WebSearchSettingsRecord, WebSearchSettingsRepository } from "../web-search/types.js";
import type { McpConfigRepository, StoredMcpServer } from "../mcp/mcp-config.js";
import type { PromptBlock, PromptSettings } from "../runtime/prompt-compiler.js";
import type { PromptSettingsRepository } from "./prompt-settings-repository.js";

type Row = Record<string, unknown>;

function toInvocationUsage(row: Row): ModelInvocationUsageRecord {
  const inputTokens = nullableNumberColumn(row, "input_tokens");
  const outputTokens = nullableNumberColumn(row, "output_tokens");
  const totalTokens = nullableNumberColumn(row, "total_tokens");
  return {
    runId: stringColumn(row, "run_id"), step: numberColumn(row, "step"), createdAt: stringColumn(row, "created_at"),
    ...(inputTokens === null ? {} : { inputTokens }),
    ...(outputTokens === null ? {} : { outputTokens }),
    ...(totalTokens === null ? {} : { totalTokens }),
  };
}

export class WorkspaceSchemaIncompatibleError extends Error {
  readonly code = "workspace_schema_incompatible";

  constructor() {
    super("Workspace database schema is incompatible. Archive the existing data directory and start with an empty one.");
    this.name = "WorkspaceSchemaIncompatibleError";
  }
}

export class SqliteWorkspaceRepository implements WorkspaceRepository, StoredFileRepository, ModelCatalogRepository, WebSearchSettingsRepository, McpConfigRepository, PromptSettingsRepository {
  private database: DatabaseSync | undefined;
  private modelCatalog: SqliteModelCatalogStore | undefined;
  private storedFiles: SqliteStoredFileStore | undefined;

  constructor(private readonly databasePath: string) {}

  async initialize(): Promise<WorkspaceIndex> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    const existed = existsSync(this.databasePath);
    this.database = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    this.modelCatalog = new SqliteModelCatalogStore(this.database, (operation) => this.transaction(operation));
    this.storedFiles = new SqliteStoredFileStore(this.database);
    try {
      if (existed) this.ensureCompatibleSchema();
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      if (!existed) this.initializeSchema();
    } catch (error) {
      this.close();
      if (error instanceof WorkspaceSchemaIncompatibleError) throw error;
      throw new WorkspaceSchemaIncompatibleError();
    }
    return {
      projects: this.all("SELECT id, owner_id, cwd, name, created_at, updated_at FROM projects ORDER BY created_at").map(toProject),
      sessions: this.all("SELECT id, owner_id, project_id, title, created_at, updated_at FROM sessions ORDER BY created_at").map(toSessionMetadata),
    };
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.modelCatalog = undefined;
    this.storedFiles = undefined;
  }

  async createProject(project: ProjectRecord): Promise<void> {
    this.db.prepare("INSERT INTO projects(id, owner_id, cwd, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(project.id, project.ownerId, project.cwd, project.name ?? null, project.created_at, project.updated_at);
  }

  async updateProject(project: ProjectRecord): Promise<void> {
    assertChanged(this.db.prepare("UPDATE projects SET owner_id = ?, cwd = ?, name = ?, updated_at = ? WHERE id = ?")
      .run(project.ownerId, project.cwd, project.name ?? null, project.updated_at, project.id), "Project", project.id);
  }

  async deleteProject(projectId: string): Promise<void> {
    assertChanged(this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId), "Project", projectId);
  }

  async createSession(session: SessionMetadataRecord): Promise<void> {
    this.db.prepare("INSERT INTO sessions(id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.id, session.ownerId, session.projectId, session.title ?? null, session.created_at, session.updated_at);
  }

  async updateSession(session: SessionMetadataRecord): Promise<void> {
    assertChanged(this.db.prepare("UPDATE sessions SET owner_id = ?, project_id = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(session.ownerId, session.projectId, session.title ?? null, session.updated_at, session.id), "Session", session.id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertChanged(this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId), "Session", sessionId);
  }

  async loadSessionContent(sessionId: string): Promise<SessionContentRecord> {
    const runRows = this.all("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY run_order", sessionId);
    const runs = runRows.map((row) => this.loadRun(row));
    const providerResponseIds: Record<string, string[]> = {};
    for (const row of this.all(`
      SELECT p.run_id, p.provider_response_id
      FROM provider_response_ids p JOIN agent_runs r ON r.id = p.run_id
      WHERE r.session_id = ? ORDER BY p.run_id, p.response_order
    `, sessionId)) {
      const runId = stringColumn(row, "run_id");
      (providerResponseIds[runId] ??= []).push(stringColumn(row, "provider_response_id"));
    }
    const contextState = this.loadSessionContextState(sessionId);
    return {
      runs,
      provider_response_ids: providerResponseIds,
      ...(contextState ? { contextState } : {}),
      compressionRecords: this.all("SELECT session_id, summarized_run_count, summary, created_at FROM context_compressions WHERE session_id = ? ORDER BY summarized_run_count", sessionId).map((row): ContextCompressionRecord => ({
        sessionId: stringColumn(row, "session_id"), summarizedRunCount: numberColumn(row, "summarized_run_count"), summary: stringColumn(row, "summary"), createdAt: stringColumn(row, "created_at"),
      })),
      invocationUsage: this.all(`SELECT u.run_id, u.step, u.input_tokens, u.output_tokens, u.total_tokens, u.created_at
        FROM model_invocation_usage u JOIN agent_runs r ON r.id = u.run_id
        WHERE r.session_id = ? ORDER BY r.run_order, u.step`, sessionId).map((row) => toInvocationUsage(row)),
      fileChanges: this.all("SELECT * FROM file_changes WHERE session_id = ? ORDER BY created_at", sessionId).map(toFileChange),
    };
  }

  async createRun(run: AgentRunRecord): Promise<void> {
    this.transaction(() => {
      const orderRow = this.db.prepare(
        "SELECT COALESCE(MAX(run_order), -1) + 1 AS next_order FROM agent_runs WHERE session_id = ?",
      ).get(run.sessionId) as Row;
      this.insertRun(run, numberColumn(orderRow, "next_order"));
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(run.updatedAt, run.sessionId);
    });
  }

  async updateRun(
    run: AgentRunRecord,
    timelineUpdates: readonly TimelineItemUpdate[],
    timelineLength: number,
    sessionUpdatedAt: string,
  ): Promise<void> {
    this.transaction(() => {
      assertChanged(this.db.prepare(`
        UPDATE agent_runs SET status = ?, model_snapshot_json = ?, permission_snapshot_json = ?, pending_tool_batch_json = ?, error_code = ?, error_message = ?,
          updated_at = ?, completed_at = ?, next_sequence_number = ?
        WHERE id = ? AND session_id = ?
      `).run(
        run.status, JSON.stringify(run.modelSnapshot), JSON.stringify(run.permissionSnapshot),
        run.pendingToolBatch ? JSON.stringify(run.pendingToolBatch) : null,
        run.error?.code ?? null, run.error?.message ?? null, run.updatedAt, run.completedAt ?? null,
        run.nextSequenceNumber, run.id, run.sessionId,
      ), "Run", run.id);
      this.updateTimeline(run.id, timelineUpdates, timelineLength);
      assertChanged(this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run(sessionUpdatedAt, run.sessionId), "Session", run.sessionId);
    });
  }

  async appendProviderResponseId(runId: string, providerResponseId: string): Promise<void> {
    this.transaction(() => {
      const exists = this.db.prepare(
        "SELECT 1 AS found FROM provider_response_ids WHERE run_id = ? AND provider_response_id = ?",
      ).get(runId, providerResponseId);
      if (exists) return;
      const order = this.db.prepare(
        "SELECT COALESCE(MAX(response_order), -1) + 1 AS next_order FROM provider_response_ids WHERE run_id = ?",
      ).get(runId) as Row;
      this.db.prepare("INSERT INTO provider_response_ids(run_id, response_order, provider_response_id) VALUES (?, ?, ?)")
        .run(runId, numberColumn(order, "next_order"), providerResponseId);
    });
  }

  async appendModelInvocationUsage(usage: ModelInvocationUsageRecord): Promise<void> {
    this.db.prepare(`INSERT INTO model_invocation_usage(run_id, step, input_tokens, output_tokens, total_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens, created_at = excluded.created_at`
    ).run(usage.runId, usage.step, usage.inputTokens ?? null, usage.outputTokens ?? null, usage.totalTokens ?? null, usage.createdAt);
  }

  async saveSessionContext(state: SessionContextStateRecord): Promise<void> {
    this.db.prepare(`INSERT INTO session_context_states(session_id, summary, summarized_run_count, last_input_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET summary = excluded.summary, summarized_run_count = excluded.summarized_run_count, last_input_tokens = excluded.last_input_tokens, updated_at = excluded.updated_at`
    ).run(state.sessionId, state.summary, state.summarizedRunCount, state.lastInputTokens ?? null, state.updatedAt);
  }

  async appendContextCompression(record: ContextCompressionRecord): Promise<void> {
    this.db.prepare(`INSERT INTO context_compressions(session_id, summarized_run_count, summary, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, summarized_run_count) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`
    ).run(record.sessionId, record.summarizedRunCount, record.summary, record.createdAt);
  }

  async appendFileChange(change: FileChangeRecord): Promise<void> {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO file_changes(id, session_id, file_path, change_type, summary, diff, new_content, old_content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(change.id, change.sessionId, change.filePath, change.changeType, change.summary,
        change.diff ?? null, change.newContent ?? null, change.oldContent ?? null, change.created_at);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(change.created_at, change.sessionId);
    });
  }

  async trimFileChanges(sessionId: string, keep: number, sessionUpdatedAt: string): Promise<void> {
    this.transaction(() => {
      this.db.prepare(`
        DELETE FROM file_changes WHERE session_id = ? AND id NOT IN (
          SELECT id FROM file_changes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
        )
      `).run(sessionId, sessionId, keep);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(sessionUpdatedAt, sessionId);
    });
  }

  async createStoredFile(file: StoredFileRecord): Promise<void> {
    return this.fileStore.createStoredFile(file);
  }

  getStoredFile(fileId: string): StoredFileRecord | undefined {
    return this.fileStore.getStoredFile(fileId);
  }

  listStoredFiles(sessionId: string): StoredFileRecord[] {
    return this.fileStore.listStoredFiles(sessionId);
  }

  async deleteExpiredUnboundFiles(olderThan: string): Promise<void> {
    return this.fileStore.deleteExpiredUnboundFiles(olderThan);
  }

  listReferencedStorageKeys(): string[] {
    return this.fileStore.listReferencedStorageKeys();
  }

  private insertRun(run: AgentRunRecord, runOrder: number): void {
    this.db.prepare(`
      INSERT INTO agent_runs(id, session_id, run_order, status, model_snapshot_json, permission_snapshot_json, pending_tool_batch_json, error_code, error_message,
        created_at, updated_at, completed_at, next_sequence_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.sessionId, runOrder, run.status, JSON.stringify(run.modelSnapshot), JSON.stringify(run.permissionSnapshot),
      run.pendingToolBatch ? JSON.stringify(run.pendingToolBatch) : null,
      run.error?.code ?? null, run.error?.message ?? null, run.createdAt, run.updatedAt,
      run.completedAt ?? null, run.nextSequenceNumber,
    );
    const insertMessage = this.db.prepare(
      "INSERT INTO run_messages(run_id, message_order, message_id, payload_json) VALUES (?, ?, ?, ?)",
    );
    const insertBinding = this.db.prepare(`
      INSERT INTO file_bindings(file_id, session_id, run_id, message_id, file_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    run.input.forEach((message, messageOrder) => {
      insertMessage.run(run.id, messageOrder, message.id, JSON.stringify(message));
      let fileOrder = 0;
      for (const part of message.content) {
        if (part.type !== "stored_file") continue;
        const file = this.db.prepare("SELECT session_id FROM stored_files WHERE id = ?").get(part.fileId) as Row | undefined;
        if (!file || stringColumn(file, "session_id") !== run.sessionId) {
          throw new Error(`Stored file does not belong to session ${run.sessionId}: ${part.fileId}`);
        }
        insertBinding.run(part.fileId, run.sessionId, run.id, message.id, fileOrder++, run.createdAt);
      }
    });
    this.updateTimeline(run.id, run.timeline.map((item, order) => ({ order, item })), run.timeline.length);
  }

  private updateTimeline(runId: string, updates: readonly TimelineItemUpdate[], timelineLength: number): void {
    const insertTimeline = this.db.prepare(
      `INSERT INTO timeline_items(run_id, item_order, item_id, item_type, payload_json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, item_order) DO UPDATE SET
         item_id = excluded.item_id, item_type = excluded.item_type, payload_json = excluded.payload_json`,
    );
    for (const { order, item } of updates) {
      const previous = this.db.prepare("SELECT item_id FROM timeline_items WHERE run_id = ? AND item_order = ?").get(runId, order) as Row | undefined;
      if (previous) this.db.prepare("DELETE FROM file_bindings WHERE run_id = ? AND message_id = ?").run(runId, stringColumn(previous, "item_id"));
      insertTimeline.run(runId, order, item.id, item.type, JSON.stringify(item));
      if (item.type === "message" || item.type === "tool_result") {
        const files = item.content.filter((part) => part.type === "stored_file");
        if (files.length) {
          const run = this.db.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(runId) as Row;
          const sessionId = stringColumn(run, "session_id");
          for (const [fileOrder, part] of files.entries()) {
            const file = this.getStoredFile(part.fileId);
            if (file?.sessionId !== sessionId) throw new Error(`Stored file does not belong to session ${sessionId}: ${part.fileId}`);
            this.db.prepare(`INSERT INTO file_bindings(file_id, session_id, run_id, message_id, file_order, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`).run(part.fileId, sessionId, runId, item.id, fileOrder, nowIso());
          }
        }
      }
    }
    this.db.prepare(`DELETE FROM file_bindings WHERE run_id = ? AND message_id IN
      (SELECT item_id FROM timeline_items WHERE run_id = ? AND item_order >= ?)`).run(runId, runId, timelineLength);
    this.db.prepare("DELETE FROM timeline_items WHERE run_id = ? AND item_order >= ?").run(runId, timelineLength);
  }

  private loadRun(row: Row): AgentRunRecord {
    const id = stringColumn(row, "id");
    const errorCode = nullableStringColumn(row, "error_code");
    const errorMessage = nullableStringColumn(row, "error_message");
    const pending = nullableStringColumn(row, "pending_tool_batch_json");
    const completedAt = nullableStringColumn(row, "completed_at");
    const modelSnapshotJson = stringColumn(row, "model_snapshot_json");
    return {
      id,
      sessionId: stringColumn(row, "session_id"),
      status: stringColumn(row, "status") as AgentRunRecord["status"],
      modelSnapshot: parseModelSnapshot(modelSnapshotJson),
      permissionSnapshot: parsePermissionSnapshot(stringColumn(row, "permission_snapshot_json")),
      input: this.all("SELECT payload_json FROM run_messages WHERE run_id = ? ORDER BY message_order", id)
        .map((item) => parseSqliteMessage(stringColumn(item, "payload_json"))),
      timeline: this.all("SELECT payload_json FROM timeline_items WHERE run_id = ? ORDER BY item_order", id)
        .map((item) => parseSqliteTimelineItem(stringColumn(item, "payload_json"))),
      ...(pending ? { pendingToolBatch: parseSqlitePendingBatch(pending) } : {}),
      ...(errorCode && errorMessage ? { error: { code: errorCode, message: errorMessage } } : {}),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      ...(completedAt ? { completedAt } : {}),
      nextSequenceNumber: numberColumn(row, "next_sequence_number"),
    };
  }

  private loadSessionContextState(sessionId: string): SessionContextStateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM session_context_states WHERE session_id = ?").get(sessionId) as Row | undefined;
    if (!row) return undefined;
    const lastInputTokens = nullableNumberColumn(row, "last_input_tokens");
    return { sessionId, summary: stringColumn(row, "summary"), summarizedRunCount: numberColumn(row, "summarized_run_count"), ...(lastInputTokens === null ? {} : { lastInputTokens }), updatedAt: stringColumn(row, "updated_at") };
  }

  private ensureCompatibleSchema(): void {
    runSqliteMigrations(this.db, SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, () => new WorkspaceSchemaIncompatibleError());
  }

  listProviderAccounts(ownerId: string): ProviderAccountRecord[] {
    return this.catalog.listProviderAccounts(ownerId);
  }

  getProviderAccount(ownerId: string, accountId: string): ProviderAccountRecord | undefined {
    return this.catalog.getProviderAccount(ownerId, accountId);
  }

  getProviderAccountVersion(ownerId: string, accountId: string, version: number): ProviderAccountRecord | undefined {
    return this.catalog.getProviderAccountVersion(ownerId, accountId, version);
  }

  async createProviderAccount({ account, credential }: CreateProviderAccountRecord): Promise<void> {
    return this.catalog.createProviderAccount({ account, credential });
  }

  async updateProviderAccount(account: ProviderAccountRecord): Promise<void> {
    return this.catalog.updateProviderAccount(account);
  }

  async replaceProviderCredential(account: ProviderAccountRecord, credential: EncryptedSecret): Promise<void> {
    return this.catalog.replaceProviderCredential(account, credential);
  }

  async deleteProviderAccount(ownerId: string, accountId: string, deletedAt: string): Promise<void> {
    return this.catalog.deleteProviderAccount(ownerId, accountId, deletedAt);
  }

  readCredential(accountId: string, version: number): EncryptedSecret | undefined {
    return this.catalog.readCredential(accountId, version);
  }

  listUserModelTargets(ownerId: string): ModelTargetRecord[] {
    return this.catalog.listUserModelTargets(ownerId);
  }

  getUserModelTarget(ownerId: string, targetId: string): ModelTargetRecord | undefined {
    return this.catalog.getUserModelTarget(ownerId, targetId);
  }

  async createUserModelTarget(target: ModelTargetRecord): Promise<void> {
    return this.catalog.createUserModelTarget(target);
  }

  async updateUserModelTarget(target: ModelTargetRecord): Promise<void> {
    return this.catalog.updateUserModelTarget(target);
  }

  async deleteUserModelTarget(ownerId: string, targetId: string): Promise<void> {
    return this.catalog.deleteUserModelTarget(ownerId, targetId);
  }

  getModelPreference(ownerId: string): ModelPreferenceRecord | undefined {
    return this.catalog.getModelPreference(ownerId);
  }

  async clearProviderCredential(account: ProviderAccountRecord): Promise<void> {
    return this.catalog.clearProviderCredential(account);
  }

  async setModelPreference(ownerId: string, preference: ModelPreferenceRecord, updatedAt: string): Promise<void> {
    return this.catalog.setModelPreference(ownerId, preference, updatedAt);
  }

  getWebSearchSettings(ownerId: string): WebSearchSettingsRecord | undefined {
    const row = this.db.prepare("SELECT * FROM web_search_settings WHERE owner_id = ?").get(ownerId) as Row | undefined;
    if (!row) return undefined;
    const keyVersion = nullableNumberColumn(row, "key_version");
    const credential = keyVersion !== null
      ? {
          ciphertext: bufferColumn(row, "ciphertext"),
          nonce: bufferColumn(row, "nonce"),
          authTag: bufferColumn(row, "auth_tag"),
          keyVersion,
        }
      : undefined;
    return {
      ownerId: stringColumn(row, "owner_id"),
      provider: stringColumn(row, "provider") as WebSearchSettingsRecord["provider"],
      mode: stringColumn(row, "mode") as WebSearchSettingsRecord["mode"],
      enabled: numberColumn(row, "enabled") === 1,
      baseUrl: stringColumn(row, "base_url"),
      ...(credential ? { credential } : {}),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  async upsertWebSearchSettings(record: WebSearchSettingsRecord): Promise<void> {
    const credential = record.credential;
    this.db.prepare(`INSERT INTO web_search_settings(
      owner_id, provider, mode, enabled, base_url, ciphertext, nonce, auth_tag, key_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET provider = excluded.provider, mode = excluded.mode, enabled = excluded.enabled,
      base_url = excluded.base_url, ciphertext = excluded.ciphertext, nonce = excluded.nonce,
      auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = excluded.updated_at`
    ).run(
      record.ownerId, record.provider, record.mode, record.enabled ? 1 : 0, record.baseUrl,
      credential?.ciphertext ?? null, credential?.nonce ?? null, credential?.authTag ?? null,
      credential?.keyVersion ?? null, record.updatedAt,
    );
  }

  async clearWebSearchCredential(ownerId: string, updatedAt: string): Promise<void> {
    this.db.prepare(`UPDATE web_search_settings SET enabled = CASE WHEN mode = 'external' THEN 0 ELSE enabled END, ciphertext = NULL, nonce = NULL,
      auth_tag = NULL, key_version = NULL, updated_at = ? WHERE owner_id = ?`).run(updatedAt, ownerId);
  }

  getPromptSettings(ownerId: string): PromptSettings | undefined {
    const row = this.db.prepare("SELECT revision, blocks_json, updated_at FROM prompt_settings WHERE owner_id = ?").get(ownerId) as Row | undefined;
    if (!row) return undefined;
    return {
      revision: numberColumn(row, "revision"),
      blocks: JSON.parse(stringColumn(row, "blocks_json")) as PromptBlock[],
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  savePromptSettings(ownerId: string, expectedRevision: number, blocks: PromptBlock[]): PromptSettings | null {
    return this.transaction(() => {
      const current = this.getPromptSettings(ownerId);
      if ((current?.revision ?? 0) !== expectedRevision) return null;
      const next: PromptSettings = { revision: expectedRevision + 1, blocks: structuredClone(blocks), updatedAt: nowIso() };
      this.db.prepare(`INSERT INTO prompt_settings(owner_id, revision, blocks_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision,
          blocks_json = excluded.blocks_json, updated_at = excluded.updated_at`)
        .run(ownerId, next.revision, JSON.stringify(next.blocks), next.updatedAt);
      return next;
    });
  }

  listMcpServers(): StoredMcpServer[] {
    return this.all("SELECT name, ciphertext, nonce, auth_tag, key_version FROM mcp_servers ORDER BY name").map((row) => ({
      name: stringColumn(row, "name"),
      credential: {
        ciphertext: bufferColumn(row, "ciphertext"),
        nonce: bufferColumn(row, "nonce"),
        authTag: bufferColumn(row, "auth_tag"),
        keyVersion: numberColumn(row, "key_version"),
      },
    }));
  }

  async upsertMcpServer(server: StoredMcpServer): Promise<void> {
    const secret = server.credential;
    this.db.prepare(`INSERT INTO mcp_servers(name, ciphertext, nonce, auth_tag, key_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
        auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = excluded.updated_at`
    ).run(server.name, secret.ciphertext, secret.nonce, secret.authTag, secret.keyVersion, nowIso());
  }

  async deleteMcpServer(name: string): Promise<void> {
    this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
  }

  private initializeSchema(): void {
    this.transaction(() => {
      this.db.exec(INITIAL_SCHEMA_SQL);
      this.db.prepare("INSERT INTO schema_metadata(id, generation, version, created_at) VALUES (1, ?, ?, ?)")
        .run(SQLITE_SCHEMA_GENERATION, SQLITE_SCHEMA_VERSION, nowIso());
    });
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...values) as Row[];
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite workspace repository is not initialized.");
    return this.database;
  }

  private get catalog(): SqliteModelCatalogStore {
    if (!this.modelCatalog) throw new Error("SQLite workspace repository is not initialized.");
    return this.modelCatalog;
  }

  private get fileStore(): SqliteStoredFileStore {
    if (!this.storedFiles) throw new Error("SQLite workspace repository is not initialized.");
    return this.storedFiles;
  }
}
