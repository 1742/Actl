import { spawn, type ChildProcess } from "node:child_process";
import { isUtf8 } from "node:buffer";
import iconv from "iconv-lite";
import { createSilentLogger, type Logger } from "../../observability/logger.js";
import { createRandomId, nowIso } from "../../utils.js";
import { ProcessOutputBuffer } from "./process-output-buffer.js";
import type {
  ExecuteProcessInput,
  ExecuteProcessResult,
  ManagedProcessPoll,
  ManagedProcessStatus,
  PollProcessInput,
  ProcessCommandInput,
  ProcessOwner,
  StartProcessInput,
  StopProcessInput,
} from "./process-types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_STARTUP_WAIT_MS = 1_000;
const MAX_WAIT_MS = 120_000;

export interface ProcessSupervisorOptions {
  maxProcessesPerOwner?: number;
  maxProcessesGlobal?: number;
  maxRuntimeMs?: number;
  maxOutputBytes?: number;
  retentionMs?: number;
  forceKillDelayMs?: number;
  terminationGraceMs?: number;
  platform?: NodeJS.Platform;
  logger?: Logger;
}

interface ManagedProcessRecord {
  id: string;
  owner: ProcessOwner;
  command: string;
  cwd: string;
  child: ChildProcess;
  output: ProcessOutputBuffer;
  status: ManagedProcessStatus;
  startedAt: string;
  completedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopRequested: boolean;
  // shell_poll long-polls wait here until new output arrives or the process exits.
  pollWaiters: Set<() => void>;
  // Startup observation and termination wait here specifically for a terminal state.
  exitWaiters: Set<() => void>;
  maxRuntimeTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
  // Concurrent stop requests share one termination sequence.
  terminationPromise?: Promise<void>;
}

export type ProcessSupervisorErrorCode =
  | "process_not_found"
  | "process_limit_exceeded"
  | "process_supervisor_disposed";

export class ProcessSupervisorError extends Error {
  constructor(readonly code: ProcessSupervisorErrorCode, message: string) {
    super(message);
  }
}

export class ProcessSupervisor {
  private readonly processes = new Map<string, ManagedProcessRecord>();
  private readonly foregroundProcesses = new Map<ChildProcess, () => void>();
  private readonly maxProcessesPerOwner: number;
  private readonly maxProcessesGlobal: number;
  private readonly maxRuntimeMs: number;
  private readonly maxOutputBytes: number;
  private readonly retentionMs: number;
  private readonly forceKillDelayMs: number;
  private readonly terminationGraceMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly logger: Logger;
  private disposed = false;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxProcessesPerOwner = options.maxProcessesPerOwner ?? 3;
    this.maxProcessesGlobal = options.maxProcessesGlobal ?? 10;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 2 * 60 * 60 * 1_000;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.retentionMs = options.retentionMs ?? 10 * 60 * 1_000;
    this.forceKillDelayMs = options.forceKillDelayMs ?? 1_000;
    this.terminationGraceMs = options.terminationGraceMs ?? 3_000;
    this.platform = options.platform ?? process.platform;
    this.logger = options.logger ?? createSilentLogger();
    assertPositiveInteger(this.maxProcessesPerOwner, "maxProcessesPerOwner");
    assertPositiveInteger(this.maxProcessesGlobal, "maxProcessesGlobal");
    assertPositiveInteger(this.maxRuntimeMs, "maxRuntimeMs");
    assertPositiveInteger(this.maxOutputBytes, "maxOutputBytes");
    assertPositiveInteger(this.retentionMs, "retentionMs");
    assertPositiveInteger(this.terminationGraceMs, "terminationGraceMs");
    if (!Number.isSafeInteger(this.forceKillDelayMs) || this.forceKillDelayMs < 0 || this.forceKillDelayMs > this.terminationGraceMs) {
      throw new RangeError("forceKillDelayMs must be a non-negative integer no greater than terminationGraceMs.");
    }
  }

  execute(input: ExecuteProcessInput): Promise<ExecuteProcessResult> {
    this.assertActive();
    input.signal?.throwIfAborted();
    const startedAt = Date.now();
    const stdout = new BoundedTextCollector(input.maxOutputBytes ?? 64 * 1024, input.outputEncoding);
    const stderr = new BoundedTextCollector(input.maxOutputBytes ?? 64 * 1024, input.outputEncoding);

    return new Promise((resolve, reject) => {
      const child = this.spawnCommand(input);
      let timedOut = false;
      let settled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      let fallbackTimer: NodeJS.Timeout | undefined;
      const abort = (): void => { void this.stopForeground(child, () => finish(null, null)); };

      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        this.foregroundProcesses.delete(child);
        clearTimeout(timeoutTimer);
        if (forceTimer) clearTimeout(forceTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        input.signal?.removeEventListener("abort", abort);
        resolve({
          command: input.command,
          cwd: input.cwd,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      };

      // Timers order: 
      // 1. timeoutTimer(kill process no force) 
      // 2. forceTimer(kill process force) 
      // 3. fallbackTimer(release and unref process)
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        this.terminateTree(child.pid, false);
        // force kill
        forceTimer = setTimeout(() => this.terminateTree(child.pid, true), this.forceKillDelayMs);
        // wait for termination to release or unref child
        fallbackTimer = setTimeout(() => {
          this.releaseChild(child);
          this.logger.warn({ event: "process.termination_unconfirmed", processType: "foreground" });
          finish(null, null);
        }, this.terminationGraceMs);
      }, input.timeoutMs);
      this.foregroundProcesses.set(child, () => finish(null, null));
      input.signal?.addEventListener("abort", abort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.on("error", (error) => {
        if (timedOut) finish(null, null);
        else if (!settled) {
          settled = true;
          this.foregroundProcesses.delete(child);
          clearTimeout(timeoutTimer);
          input.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      child.on("close", (exitCode, signal) => finish(exitCode, signal));
    });
  }

  async start(input: StartProcessInput): Promise<ManagedProcessPoll> {
    this.assertActive();
    input.signal?.throwIfAborted();
    this.assertCapacity(input.owner);
    const startupWaitMs = input.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
    if (!Number.isInteger(startupWaitMs) || startupWaitMs < 0 || startupWaitMs > MAX_WAIT_MS) {
      throw new RangeError(`startupWaitMs must be an integer between 0 and ${MAX_WAIT_MS}.`);
    }

    const child = this.spawnCommand(input);
    const record: ManagedProcessRecord = {
      id: createRandomId("proc"),
      owner: structuredClone(input.owner),
      command: input.command,
      cwd: input.cwd,
      child,
      output: new ProcessOutputBuffer(this.maxOutputBytes),
      status: "running",
      startedAt: nowIso(),
      exitCode: null,
      signal: null,
      stopRequested: false,
      pollWaiters: new Set(),
      exitWaiters: new Set(),
    };
    this.processes.set(record.id, record);
    this.attachRecord(record, input.outputEncoding);
    record.maxRuntimeTimer = setTimeout(() => void this.stopRecord(record), this.maxRuntimeMs);
    record.maxRuntimeTimer.unref();

    const abort = (): void => { void this.stopRecord(record); };
    input.signal?.addEventListener("abort", abort, { once: true });

    try {
      if (startupWaitMs > 0 && record.status === "running") {
        await waitWithSignal(this.waitForExit(record, startupWaitMs), input.signal);
      }
      input.signal?.throwIfAborted();
      return this.snapshot(record, 0);
    } catch (error) {
      if (input.signal?.aborted) await this.stopRecord(record);
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async poll(input: PollProcessInput): Promise<ManagedProcessPoll> {
    input.signal?.throwIfAborted();
    const record = this.requireOwnedProcess(input.owner, input.processId);
    const cursor = input.cursor ?? 0;
    const line = input.line;
    const waitMs = input.waitMs ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("cursor must be a non-negative integer.");
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new RangeError("line must be a positive integer.");
    if (line !== undefined && input.cursor !== undefined) throw new RangeError("cursor and line cannot be used together.");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new RangeError(`waitMs must be an integer between 0 and ${MAX_WAIT_MS}.`);
    }
    const current = line === undefined ? record.output.readAfter(cursor) : record.output.readFromLine(line);
    if (waitMs > 0 && record.status === "running") {
      if (input.waitForExit) await waitWithSignal(this.waitForExit(record, waitMs), input.signal);
      else if (current.chunks.length === 0) await waitWithSignal(this.waitForChange(record, waitMs), input.signal);
    }
    input.signal?.throwIfAborted();
    return this.snapshot(record, cursor, line);
  }

  async stop(input: StopProcessInput): Promise<ManagedProcessPoll> {
    const record = this.requireOwnedProcess(input.owner, input.processId);
    const cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError("cursor must be a non-negative integer.");
    if (input.line !== undefined && (!Number.isSafeInteger(input.line) || input.line < 1)) throw new RangeError("line must be a positive integer.");
    if (input.line !== undefined && input.cursor !== undefined) throw new RangeError("cursor and line cannot be used together.");
    await this.stopRecord(record);
    return this.snapshot(record, cursor, input.line);
  }

  async stopByOwner(owner: ProcessOwner): Promise<void> {
    const records = [...this.processes.values()].filter((record) => sameOwner(record.owner, owner));
    await Promise.all(records.map((record) => this.stopRecord(record)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all([
      ...[...this.processes.values()].map((record) => this.stopRecord(record)),
      ...[...this.foregroundProcesses.entries()].map(([child, finish]) => this.stopForeground(child, finish)),
    ]);
    for (const record of this.processes.values()) {
      if (record.retentionTimer) clearTimeout(record.retentionTimer);
    }
    this.processes.clear();
    this.foregroundProcesses.clear();
  }

  owns(owner: ProcessOwner, processId: string): boolean {
    const record = this.processes.get(processId);
    return record !== undefined && sameOwner(record.owner, owner);
  }

  private spawnCommand(input: ProcessCommandInput): ChildProcess {
    return spawn(input.command, {
      cwd: input.cwd,
      shell: input.shell,
      ...(input.env ? { env: input.env } : {}),
      windowsHide: true,
      detached: this.platform !== "win32",
    });
  }

  private attachRecord(record: ManagedProcessRecord, outputEncoding: string): void {
    const stdoutDecoder = iconv.getDecoder(outputEncoding);
    const stderrDecoder = iconv.getDecoder(outputEncoding);
    record.child.stdout?.on("data", (chunk: Buffer) => {
      record.output.append("stdout", stdoutDecoder.write(chunk));
      this.wakePollWaiters(record);
    });
    record.child.stderr?.on("data", (chunk: Buffer) => {
      record.output.append("stderr", stderrDecoder.write(chunk));
      this.wakePollWaiters(record);
    });
    record.child.on("error", (error) => {
      record.output.append("stderr", `${error.message}\n`);
      this.completeRecord(record, "failed", null, null);
    });
    record.child.on("close", (exitCode, signal) => {
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) record.output.append("stdout", stdoutTail);
      if (stderrTail) record.output.append("stderr", stderrTail);
      this.completeRecord(record, record.stopRequested ? "stopped" : "exited", exitCode, signal);
    });
  }

  private async stopRecord(record: ManagedProcessRecord): Promise<void> {
    if (record.status !== "running") return;
    record.terminationPromise ??= this.terminateRecord(record);
    await record.terminationPromise;
  }

  /**
   * 1. try to terminate the process no forcefully
   * 2. if it's still running, try to kill it forcefully
   * 3. if it's still running, release reference to the child process
   * @param record 
   * @returns 
   */
  private async terminateRecord(record: ManagedProcessRecord): Promise<void> {
    record.stopRequested = true;
    this.terminateTree(record.child.pid, false);
    await this.waitForExit(record, this.forceKillDelayMs);
    if (record.status !== "running") return;
    this.terminateTree(record.child.pid, true);
    await this.waitForExit(record, Math.max(0, this.terminationGraceMs - this.forceKillDelayMs));
    if (record.status === "running") {
      this.releaseChild(record.child);
      this.logger.warn({ event: "process.termination_unconfirmed", processId: record.id, ownerId: record.owner.id });
      this.completeRecord(record, "stopped", null, null);
    }
  }

  private completeRecord(
    record: ManagedProcessRecord,
    status: Exclude<ManagedProcessStatus, "running">,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (record.status !== "running") return;
    record.status = status;
    record.exitCode = exitCode;
    record.signal = signal;
    record.completedAt = nowIso();
    if (record.maxRuntimeTimer) clearTimeout(record.maxRuntimeTimer);
    record.retentionTimer = setTimeout(() => this.processes.delete(record.id), this.retentionMs);
    record.retentionTimer.unref();
    this.wakePollWaiters(record);
    for (const waiter of record.exitWaiters) waiter();
    record.exitWaiters.clear();
  }

  private snapshot(record: ManagedProcessRecord, cursor: number, line?: number): ManagedProcessPoll {
    const output = line === undefined ? record.output.readAfter(cursor) : record.output.readFromLine(line);
    return {
      processId: record.id,
      status: record.status,
      command: record.command,
      cwd: record.cwd,
      startedAt: record.startedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      exitCode: record.exitCode,
      signal: record.signal,
      output: output.chunks,
      nextCursor: output.nextCursor,
      nextLine: output.nextLine,
      outputTruncated: output.truncated,
    };
  }

  private requireOwnedProcess(owner: ProcessOwner, processId: string): ManagedProcessRecord {
    const record = this.processes.get(processId);
    if (!record || !sameOwner(record.owner, owner)) {
      throw new ProcessSupervisorError("process_not_found", "process_not_found");
    }
    return record;
  }

  private assertCapacity(owner: ProcessOwner): void {
    const running = [...this.processes.values()].filter((record) => record.status === "running");
    if (running.length >= this.maxProcessesGlobal) {
      throw new ProcessSupervisorError("process_limit_exceeded", "Global background process limit exceeded.");
    }
    if (running.filter((record) => sameOwner(record.owner, owner)).length >= this.maxProcessesPerOwner) {
      throw new ProcessSupervisorError("process_limit_exceeded", "Session background process limit exceeded.");
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ProcessSupervisorError("process_supervisor_disposed", "Process supervisor has been disposed.");
    }
  }

  // Wake shell_poll calls because output arrived or the process reached a terminal state.
  private wakePollWaiters(record: ManagedProcessRecord): void {
    for (const waiter of record.pollWaiters) waiter();
    record.pollWaiters.clear();
  }

  // Keep a poll pending until output/exit wakes it, with waitMs as the maximum wait.
  private waitForChange(record: ManagedProcessRecord, waitMs: number): Promise<void> {
    if (waitMs <= 0 || record.status !== "running") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.pollWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      record.pollWaiters.add(finish);
    });
  }

  // Wait for completeRecord() to report exit, or continue after the bounded timeout.
  private waitForExit(record: ManagedProcessRecord, waitMs: number): Promise<void> {
    if (waitMs <= 0 || record.status !== "running") return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.exitWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      record.exitWaiters.add(finish);
    });
  }

  private terminateTree(pid: number | undefined, force: boolean): void {
    if (pid === undefined) return;
    if (this.platform === "win32") {
      const args = ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])];
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => tryKill(pid, force ? "SIGKILL" : "SIGTERM"));
      return;
    }
    tryKill(-pid, force ? "SIGKILL" : "SIGTERM");
  }

  /**
   * Release reference to a child process. The child process will still exist.
   */
  private releaseChild(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }

  private async stopForeground(child: ChildProcess, finish: () => void): Promise<void> {
    this.terminateTree(child.pid, false);
    await delay(this.forceKillDelayMs);
    if (this.foregroundProcesses.has(child)) this.terminateTree(child.pid, true);
    await delay(Math.max(0, this.terminationGraceMs - this.forceKillDelayMs));
    if (this.foregroundProcesses.has(child)) {
      this.releaseChild(child);
      finish();
    }
  }
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class BoundedTextCollector {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private wasTruncated = false;

  constructor(private readonly maxBytes: number, private readonly encoding: string) {}

  get truncated(): boolean {
    return this.wasTruncated;
  }

  append(chunk: Buffer): void {
    if (this.bytes >= this.maxBytes) {
      this.wasTruncated = true;
      return;
    }
    const available = this.maxBytes - this.bytes;
    const accepted = chunk.byteLength > available ? chunk.subarray(0, available) : chunk;
    this.chunks.push(accepted);
    this.bytes += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) this.wasTruncated = true;
  }

  text(): string {
    const output = Buffer.concat(this.chunks);
    return isUtf8(output) ? output.toString("utf8") : iconv.decode(output, this.encoding);
  }
}

function sameOwner(left: ProcessOwner, right: ProcessOwner): boolean {
  return left.type === right.type && left.id === right.id;
}

function tryKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Termination is best effort; bounded fallbacks keep tool calls responsive.
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer.`);
}
