import type { AgentRunRecord, AgentTimelineItem } from "../runtime/agent-domain.js";
import type { ModelUsage } from "../model/types.js";
import type { AgentProfile } from "../../shared/agent/profiles.js";

export interface SessionContextStateRecord {
  sessionId: string;
  summary: string;
  summarizedRunCount: number;
  lastInputTokens?: number;
  updatedAt: string;
}

export interface ModelInvocationUsageRecord extends ModelUsage {
  runId: string;
  step: number;
  createdAt: string;
}

export interface ContextCompressionRecord {
  sessionId: string;
  summarizedRunCount: number;
  summary: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  parentSessionId?: string;
  rootSessionId?: string;
  originRunId?: string;
  originCallId?: string;
  profile?: AgentProfile;
  ownerId: string;
  projectId: string | null;
  title?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionContentRecord {
  runs: AgentRunRecord[];
  provider_response_ids: Record<string, string[]>;
  contextState?: SessionContextStateRecord;
  compressionRecords: ContextCompressionRecord[];
  invocationUsage: ModelInvocationUsageRecord[];
  fileChanges?: FileChangeRecord[];
}

export interface FileChangeRecord {
  id: string;
  sessionId: string;
  runId?: string;
  filePath: string;
  changeType: "create" | "modify" | "delete";
  summary: string;
  diff?: string;
  newContent?: string;
  oldContent?: string;
  created_at: string;
}

export interface TimelineItemUpdate {
  order: number;
  item: AgentTimelineItem;
}

export interface SessionRepository {
  listSessions(): Promise<SessionRecord[]>;
  createSession(session: SessionRecord): Promise<void>;
  updateSession(session: SessionRecord): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  loadSessionContent(sessionId: string): Promise<SessionContentRecord>;
  createRun(run: AgentRunRecord): Promise<void>;
  updateRun(
    run: AgentRunRecord,
    timelineUpdates: readonly TimelineItemUpdate[],
    timelineLength: number,
    sessionUpdatedAt: string,
  ): Promise<void>;
  appendProviderResponseId(runId: string, providerResponseId: string): Promise<void>;
  appendModelInvocationUsage(usage: ModelInvocationUsageRecord): Promise<void>;
  saveSessionContext(state: SessionContextStateRecord): Promise<void>;
  appendContextCompression(record: ContextCompressionRecord): Promise<void>;
  appendFileChange(change: FileChangeRecord): Promise<void>;
  trimFileChanges(sessionId: string, keep: number, sessionUpdatedAt: string): Promise<void>;
}
