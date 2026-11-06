import { utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentBootOptions, AgentCommand, AgentResult, AgentRuntimeInfo, AgentWorkerResponse } from '../shared/agent-ipc';

interface Pending { resolve: (result: AgentResult) => void; onEvents?: ((events: unknown[]) => void) | undefined }

export class AgentProcessHost {
  private child: UtilityProcess | undefined;
  private boot: Promise<AgentRuntimeInfo> | undefined;
  private pending = new Map<string, Pending>();
  private closing = false;
  private stopTask: Promise<void> | undefined;
  private stopped = false;

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
    await mkdir(this.options.homeDirectory, { recursive: true });
    return new Promise((resolve, reject) => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = utilityProcess.fork(path.join(__dirname, 'agent-worker.cjs'), [], {
        cwd: this.options.homeDirectory, env: environment, stdio: 'pipe', serviceName: 'Actl Agent',
      });
      this.child = child;
      this.stopped = false;
      let initialized = false;
      let stderr = '';
      child.stdout?.resume();
      child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-4_000); });
      const deadline = setTimeout(() => {
        reject(new Error(`Agent startup timed out. ${stderr}`));
        this.killTree(child);
      }, 30_000);
      child.on('message', (message: AgentWorkerResponse) => {
        if (message.type === 'ready') child.postMessage({ type: 'initialize', options: this.options });
        else if (message.type === 'initialized') {
          clearTimeout(deadline);
          if (message.result.ok) { initialized = true; resolve(message.result.value); }
          else { reject(new Error(message.result.error.message)); this.killTree(child); }
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
    if (!child) return;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { this.killTree(child); }, 12_000);
      const finalDeadline = setTimeout(() => { child.kill(); reject(new Error('Agent shutdown timed out.')); }, 15_000);
      child.once('exit', (code) => {
        clearTimeout(deadline); clearTimeout(finalDeadline);
        if (code === 0 && this.stopped) resolve(); else reject(new Error(`Agent shutdown was not acknowledged (${code}).`));
      });
      child.postMessage({ type: 'shutdown' });
    });
  }

  private killTree(child: UtilityProcess): void {
    if (!child.pid) return;
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  }
}
