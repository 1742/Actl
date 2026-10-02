export type ProcessOwner = { type: "session"; id: string };

export type ManagedProcessStatus = "running" | "exited" | "stopped" | "failed";

export interface ProcessOutputChunk {
  cursor: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ProcessCommandInput {
  command: string;
  cwd: string;
  shell: string;
  outputEncoding: string;
  env?: NodeJS.ProcessEnv;
}

export interface ExecuteProcessInput extends ProcessCommandInput {
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecuteProcessResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface StartProcessInput extends ProcessCommandInput {
  owner: ProcessOwner;
  startupWaitMs?: number;
  signal?: AbortSignal;
}

export interface ManagedProcessPoll {
  processId: string;
  status: ManagedProcessStatus;
  command: string;
  cwd: string;
  startedAt: string;
  completedAt?: string;
  /** The shell's raw exit code. Treat it as a command result only when status is "exited". */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: ProcessOutputChunk[];
  nextCursor: number;
  /** Next line to request for line-based reads. A trailing unfinished line may be returned again. */
  nextLine: number;
  outputTruncated: boolean;
}

export interface PollProcessInput {
  owner: ProcessOwner;
  processId: string;
  cursor?: number;
  line?: number;
  waitMs?: number;
  waitForExit?: boolean;
  signal?: AbortSignal;
}

export interface StopProcessInput {
  owner: ProcessOwner;
  processId: string;
  cursor?: number;
  line?: number;
}
