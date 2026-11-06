import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';

// The main process owns the only handle. Windows also closes it if the app is
// killed, so cleanup does not depend on JS shutdown handlers or live parent PIDs.
const kernel = koffi.load('kernel32.dll');
const basicLimits = koffi.struct({
  PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uintptr', MaximumWorkingSetSize: 'uintptr',
  ActiveProcessLimit: 'uint32', Affinity: 'uintptr', PriorityClass: 'uint32', SchedulingClass: 'uint32',
});
const extendedLimits = koffi.struct({
  BasicLimitInformation: basicLimits,
  IoInfo: koffi.struct({
    ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
  }),
  ProcessMemoryLimit: 'uintptr', JobMemoryLimit: 'uintptr',
  PeakProcessMemoryUsed: 'uintptr', PeakJobMemoryUsed: 'uintptr',
});
const accounting = koffi.struct({
  TotalUserTime: 'int64', TotalKernelTime: 'int64',
  ThisPeriodTotalUserTime: 'int64', ThisPeriodTotalKernelTime: 'int64',
  TotalPageFaultCount: 'uint32', TotalProcesses: 'uint32', ActiveProcesses: 'uint32', TotalTerminatedProcesses: 'uint32',
});
const createJob = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
const setInformation = kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', koffi.pointer(extendedLimits), 'uint32']);
const queryInformation = kernel.func('__stdcall', 'QueryInformationJobObject', 'int', ['void *', 'int', koffi.out(koffi.pointer(accounting)), 'uint32', 'void *']);
const openProcess = kernel.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
const assignProcess = kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
const terminateJob = kernel.func('int __stdcall TerminateJobObject(void *job, uint32 exitCode)');
const closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)');
const lastError = kernel.func('uint32 __stdcall GetLastError()');
const failure = (operation: string) => new Error(`${operation} failed (Windows error ${lastError()}).`);

export class WindowsProcessJob {
  private handle: unknown;
  private cleanup: Promise<void> | undefined;

  constructor() {
    this.handle = createJob(null, null);
    if (!this.handle) throw failure('CreateJobObjectW');
    // No breakaway flags: detached Shell and MCP descendants stay in this job.
    if (!setInformation(this.handle, 9, { BasicLimitInformation: { LimitFlags: 0x2000 } }, koffi.sizeof(extendedLimits))) {
      const error = failure('SetInformationJobObject');
      closeHandle(this.handle); this.handle = undefined; throw error;
    }
  }

  assign(pid: number): void {
    const child = openProcess(0x0100 | 0x0001, 0, pid); // SET_QUOTA | TERMINATE
    if (!child) throw failure('OpenProcess');
    try { if (!assignProcess(this.handle, child)) throw failure('AssignProcessToJobObject'); }
    finally { closeHandle(child); }
  }

  terminate(): void {
    if (this.handle && !terminateJob(this.handle, 1)) throw failure('TerminateJobObject');
  }

  close(): Promise<void> { return this.cleanup ??= this.dispose(); }

  private async dispose(): Promise<void> {
    if (!this.handle) return;
    try {
      this.terminate();
      const deadline = Date.now() + 5_000;
      for (;;) {
        const info = { ActiveProcesses: 0 };
        if (!queryInformation(this.handle, 1, info, koffi.sizeof(accounting), null)) throw failure('QueryInformationJobObject');
        if (info.ActiveProcesses === 0) return;
        if (Date.now() >= deadline) throw new Error('Agent descendants did not exit within 5 seconds.');
        await delay(25);
      }
    } finally {
      closeHandle(this.handle);
      this.handle = undefined;
    }
  }
}
