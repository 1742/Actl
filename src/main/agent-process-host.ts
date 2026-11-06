import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentBootOptions, AgentCommand, AgentResult, AgentRuntimeInfo, AgentWorkerResponse } from '../shared/agent-ipc';
import { WindowsProcessJob } from './windows-process-job';

interface Pending { resolve: (result: AgentResult) => void; onEvents?: ((events: unknown[]) => void) | undefined }

export class AgentProcessHost {
  private child: UtilityProcess | undefined;
  private boot: Promise<AgentRuntimeInfo> | undefined;
  private pending = new Map<string, Pending>();
  private closing = false;
  private stopTask: Promise<void> | undefined;
  private stopped = false;
  private reaped: Promise<void> = Promise.resolve();
  private job: WindowsProcessJob | undefined;

  get pid(): number | undefined { return this.child?.pid; }

  constructor(private readonly options: AgentBootOptions) {}

  async ready(): Promise<AgentRuntimeInfo> {
    if (this.closing) throw new Error('Agent is shutting down.');
    if (this.boot) return this.boot;
    this.boot = this.launch();
    return this.boot;
  }

  async request(command: AgentCommand, onEvents?: (events: unknown[]) => void, id: string = randomUUID()): Promise<AgentResult> {
    await this.ready();
    if (this.closing || !this.child) throw new Error('Agent is unavailable.');
    if (this.pending.size >= 64) throw new Error('Too many pending Agent requests.');
    if (this.pending.has(id)) throw new Error('Duplicate Agent request ID.');
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, onEvents });
      this.child!.postMessage({ type: 'request', id, command, stream: !!onEvents });
    });
  }

  detach(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.onEvents = undefined;
    this.child?.postMessage({ type: 'detach', id });
  }

  close(): Promise<void> {
    return this.stopTask ??= this.shutdown();
  }

  private async launch(): Promise<AgentRuntimeInfo> {
    await this.reaped;
    await mkdir(this.options.homeDirectory, { recursive: true });
    const job = new WindowsProcessJob();
    this.job = job;
    return new Promise((resolve, reject) => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(path.join(__dirname, 'agent-worker.cjs'), [], {
          cwd: this.options.homeDirectory, env: environment, stdio: 'pipe', serviceName: 'Actl Agent',
        });
      } catch (error) { this.reaped = job.close(); reject(error); return; }
      this.child = child;
      this.stopped = false;
      let initialized = false;
      let assigned = false;
      let workerReady = false;
      const initialize = () => {
        if (assigned && workerReady) child.postMessage({ type: 'initialize', options: this.options });
      };
      let stderr = '';
      child.stdout?.resume();
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-4_000); });
      const deadline = setTimeout(() => {
        reject(new Error(`Agent startup timed out. ${stderr}`));
        this.killTree(child, job);
      }, 30_000);
      child.once('spawn', () => {
        try {
          if (!child.pid) throw new Error('Agent spawned without a PID.');
          job.assign(child.pid);
          assigned = true;
          initialize();
        } catch (error) {
          clearTimeout(deadline); reject(error); child.kill();
        }
      });
      child.on('message', (message: AgentWorkerResponse) => {
        if (message.type === 'ready') { workerReady = true; initialize(); }
        else if (message.type === 'initialized') {
          clearTimeout(deadline);
          if (message.result.ok) { initialized = true; resolve(message.result.value); }
          else { reject(new Error(message.result.error.message)); this.killTree(child, job); }
        } else if (message.type === 'events') {
          const pending = this.pending.get(message.id);
          try { pending?.onEvents?.(message.events); }
          catch { if (pending) pending.onEvents = undefined; child.postMessage({ type: 'detach', id: message.id }); }
        }
        else if (message.type === 'stopped') this.stopped = true;
        else if (message.type === 'result') {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          pending?.resolve(message.result);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(deadline);
        this.reaped = job.close();
        // Keep the rejection observable by close()/the next launch as well.
        void this.reaped.catch((error) => console.error('Agent descendant cleanup failed:', error));
        if (!initialized) reject(new Error(`Agent failed to start (${code}). ${stderr}`));
        if (this.child === child) { this.child = undefined; this.boot = undefined; }
        for (const pending of this.pending.values()) pending.resolve({ ok: false, error: { code: 'runtime_interrupted', message: 'Agent process exited. Reload the conversation to recover persisted history.' } });
        this.pending.clear();
      });
    });
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    if (this.boot) await this.boot.catch(() => undefined);
    const child = this.child;
    const job = this.job;
    if (!child) { await this.reaped; return; }
    try { await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill(); }, 12_000);
      const finalDeadline = setTimeout(() => { child.kill(); reject(new Error('Agent shutdown timed out.')); }, 15_000);
      child.once('exit', (code) => {
        clearTimeout(deadline); clearTimeout(finalDeadline);
        if (code === 0 && this.stopped) resolve(); else reject(new Error(`Agent shutdown was not acknowledged (${code}).`));
      });
      child.postMessage({ type: 'shutdown' });
    }); } finally { await job?.close(); await this.reaped; }
  }

  private killTree(child: UtilityProcess, job: WindowsProcessJob): void {
    try { job.terminate(); } catch (error) { console.error('Agent termination failed:', error); }
    // Also handles an early startup failure before job assignment.
    child.kill();
  }
}
