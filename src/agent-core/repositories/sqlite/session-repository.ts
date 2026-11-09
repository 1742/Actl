import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AgentRunRecord } from "../../runtime/agent-domain.js";
import { nowIso } from "../../utils.js";
import type {
  ContextCompressionRecord, FileChangeRecord, ModelInvocationUsageRecord, SessionContentRecord,
  SessionContextStateRecord, SessionRecord, SessionRepository, TimelineItemUpdate,
} from "../session-repository.js";
import type { StoredFileRepository } from "../stored-file-repository.js";
import { withSqliteTransaction } from "./database.js";
import {
  assertChanged, nullableNumberColumn, nullableStringColumn, numberColumn, stringColumn, type SqliteRow,
} from "./row.js";
import {
  parseModelSnapshot, parsePermissionSnapshot, parseSqliteMessage, parseSqlitePendingBatch, parseSqliteTimelineItem,
} from "./run-payload-codec.js";

function toSessionMetadata(row: SqliteRow): SessionRecord {
  const title = nullableStringColumn(row, "title");
  return {
    ...(row.parent_session_id ? { parentSessionId: stringColumn(row, 'parent_session_id') } : {}),
    rootSessionId: nullableStringColumn(row, 'root_session_id') ?? stringColumn(row, 'id'),
    ...(row.origin_run_id ? { originRunId: stringColumn(row, 'origin_run_id') } : {}),
    ...(row.origin_call_id ? { originCallId: stringColumn(row, 'origin_call_id') } : {}),
    id: stringColumn(row, "id"), ownerId: stringColumn(row, "owner_id"), projectId: nullableStringColumn(row, "project_id"),
    ...(title ? { title } : {}), created_at: stringColumn(row, "created_at"), updated_at: stringColumn(row, "updated_at"),
  };
}

function toFileChange(row: SqliteRow): FileChangeRecord {
  const runId = nullableStringColumn(row, "run_id");
  const diff = nullableStringColumn(row, "diff");
  const newContent = nullableStringColumn(row, "new_content");
  const oldContent = nullableStringColumn(row, "old_content");
  return {
    id: stringColumn(row, "id"), sessionId: stringColumn(row, "session_id"), filePath: stringColumn(row, "file_path"),
    ...(runId === null ? {} : { runId }),
    changeType: stringColumn(row, "change_type") as FileChangeRecord["changeType"], summary: stringColumn(row, "summary"),
    ...(diff === null ? {} : { diff }), ...(newContent === null ? {} : { newContent }),
    ...(oldContent === null ? {} : { oldContent }), created_at: stringColumn(row, "created_at"),
  };
}

function toInvocationUsage(row: SqliteRow): ModelInvocationUsageRecord {
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

export class SqliteSessionRepository implements SessionRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly storedFiles: Pick<StoredFileRepository, "getStoredFile">,
  ) {}

  async listSessions(): Promise<SessionRecord[]> {
    return this.all("SELECT * FROM sessions ORDER BY created_at").map(toSessionMetadata);
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.db.prepare("INSERT INTO sessions(id, owner_id, project_id, title, created_at, updated_at, parent_session_id, root_session_id, origin_run_id, origin_call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(session.id, session.ownerId, session.projectId, session.title ?? null, session.created_at, session.updated_at,
        session.parentSessionId ?? null, session.rootSessionId ?? session.id, session.originRunId ?? null, session.originCallId ?? null);
  }

  async updateSession(session: SessionRecord): Promise<void> {
    assertChanged(this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(session.title ?? null, session.updated_at, session.id), "Session", session.id);
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
    withSqliteTransaction(this.db, () => {
      const orderRow = this.db.prepare(
        "SELECT COALESCE(MAX(run_order), -1) + 1 AS next_order FROM agent_runs WHERE session_id = ?",
      ).get(run.sessionId) as SqliteRow;
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
    withSqliteTransaction(this.db, () => {
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
    withSqliteTransaction(this.db, () => {
      const exists = this.db.prepare(
        "SELECT 1 AS found FROM provider_response_ids WHERE run_id = ? AND provider_response_id = ?",
      ).get(runId, providerResponseId);
      if (exists) return;
      const order = this.db.prepare(
        "SELECT COALESCE(MAX(response_order), -1) + 1 AS next_order FROM provider_response_ids WHERE run_id = ?",
      ).get(runId) as SqliteRow;
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
    withSqliteTransaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO file_changes(id, session_id, run_id, file_path, change_type, summary, diff, new_content, old_content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET new_content = excluded.new_content, created_at = excluded.created_at
      `).run(change.id, change.sessionId, change.runId ?? null, change.filePath, change.changeType, change.summary,
        change.diff ?? null, change.newContent ?? null, change.oldContent ?? null, change.created_at);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(change.created_at, change.sessionId);
    });
  }

  async trimFileChanges(sessionId: string, keep: number, sessionUpdatedAt: string): Promise<void> {
    withSqliteTransaction(this.db, () => {
      this.db.prepare(`
        DELETE FROM file_changes WHERE session_id = ? AND id NOT IN (
          SELECT id FROM file_changes WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
        )
      `).run(sessionId, sessionId, keep);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(sessionUpdatedAt, sessionId);
    });
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
        const file = this.db.prepare("SELECT session_id FROM stored_files WHERE id = ?").get(part.fileId) as SqliteRow | undefined;
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
      const previous = this.db.prepare("SELECT item_id FROM timeline_items WHERE run_id = ? AND item_order = ?").get(runId, order) as SqliteRow | undefined;
      if (previous) this.db.prepare("DELETE FROM file_bindings WHERE run_id = ? AND message_id = ?").run(runId, stringColumn(previous, "item_id"));
      insertTimeline.run(runId, order, item.id, item.type, JSON.stringify(item));
      if (item.type === "message" || item.type === "tool_result") {
        const files = item.content.filter((part) => part.type === "stored_file");
        if (files.length) {
          const run = this.db.prepare("SELECT session_id FROM agent_runs WHERE id = ?").get(runId) as SqliteRow;
          const sessionId = stringColumn(run, "session_id");
          for (const [fileOrder, part] of files.entries()) {
            const file = this.storedFiles.getStoredFile(part.fileId);
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

  private loadRun(row: SqliteRow): AgentRunRecord {
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
    const row = this.db.prepare("SELECT * FROM session_context_states WHERE session_id = ?").get(sessionId) as SqliteRow | undefined;
    if (!row) return undefined;
    const lastInputTokens = nullableNumberColumn(row, "last_input_tokens");
    return { sessionId, summary: stringColumn(row, "summary"), summarizedRunCount: numberColumn(row, "summarized_run_count"), ...(lastInputTokens === null ? {} : { lastInputTokens }), updatedAt: stringColumn(row, "updated_at") };
  }

  private all(sql: string, ...values: SQLInputValue[]): SqliteRow[] {
    return this.db.prepare(sql).all(...values) as SqliteRow[];
  }
}
