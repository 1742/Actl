import { utilityProcess, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CompatibilityReport, VerificationOptions, WorkerMessage } from '../shared/compatibility';

export class RuntimeHost {
  private active: Promise<CompatibilityReport> | undefined;

  get pending(): Promise<CompatibilityReport> | undefined {
    return this.active;
  }

  run(options: VerificationOptions): Promise<CompatibilityReport> {
    if (this.active) return this.active;
    const operation = this.launch(options);
    this.active = operation;
    void operation.finally(() => { this.active = undefined; }).catch(() => undefined);
    return operation;
  }

  private launch(options: VerificationOptions): Promise<CompatibilityReport> {
    return new Promise((resolve, reject) => {
      let child: UtilityProcess;
      let report: Omit<CompatibilityReport, 'shutdown'> | undefined;
      let acknowledged = false;
      let stderr = '';
      let failure: Error | undefined;
      let settled = false;
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (failure || !report) {
          reject(failure ?? new Error(`Runtime exited before reporting results (${exitCode}). ${stderr}`));
        } else {
          resolve({
            ...report,
            passed: report.passed && acknowledged && exitCode === 0,
            shutdown: { acknowledged, exitCode },
          });
        }
      };
      const deadline = setTimeout(() => {
        failure = new Error(`Compatibility runtime timed out. ${stderr}`);
        // Kill only this test runtime and its descendants if graceful cleanup stalls.
        if (child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
        finish(1);
      }, 45_000);

      try {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        child = utilityProcess.fork(path.join(__dirname, 'runtime-worker.cjs'), [], {
          cwd: options.dataDirectory,
          stdio: 'pipe',
          serviceName: 'Actl Agent Compatibility',
          env: environment,
        });
        child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + String(chunk)).slice(-8_000); });
        child.on('message', (message: WorkerMessage) => {
          if (message.type === 'ready') child.postMessage({ type: 'run', options });
          else if (message.type === 'complete') {
            report = message.report;
            child.postMessage({ type: 'shutdown' });
          } else if (message.type === 'fatal') {
            failure = new Error(message.message);
            child.postMessage({ type: 'shutdown' });
          } else if (message.type === 'stopped') acknowledged = true;
        });
        child.once('exit', finish);
      } catch (error) {
        clearTimeout(deadline);
        reject(error);
      }
    });
  }
}
