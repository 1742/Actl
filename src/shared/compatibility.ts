export interface CompatibilityCheck {
  id: string;
  name: string;
  status: 'passed' | 'failed';
  durationMs: number;
  details: string;
}

export interface CompatibilityReport {
  passed: boolean;
  startedAt: string;
  completedAt: string;
  dataDirectory: string;
  packaged: boolean;
  versions: { electron: string; node: string; chrome: string; platform: string; arch: string };
  utilityPid: number;
  mainPid: number;
  checks: CompatibilityCheck[];
  shutdown: { acknowledged: boolean; exitCode: number | null };
}

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'check'; check: CompatibilityCheck }
  | { type: 'complete'; report: Omit<CompatibilityReport, 'shutdown'> }
  | { type: 'fatal'; message: string }
  | { type: 'stopped' };

export interface VerificationOptions {
  dataDirectory: string;
  fixturePath: string;
  packaged: boolean;
  mainPid: number;
}

export interface CompatibilityApi {
  runChecks(): Promise<CompatibilityReport>;
}
