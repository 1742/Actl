import type { AgentResponseDto } from "./responses.js";

export interface AgentProject {
  id: string;
  cwd: string;
  name?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSession {
  id: string;
  projectId: string | null;
  title?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionContextCompression {
  summarized_run_count: number;
  summary: string;
  created_at: string;
}

export interface SessionContextSummary {
  last_input_tokens?: number | undefined;
  summarized_run_count: number;
  compressions: SessionContextCompression[];
}

export interface SessionContext {
  session_id: string;
  responses: AgentResponseDto[];
  context: SessionContextSummary;
}
