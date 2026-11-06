export interface VerificationCheck {
  name: string;
  passed: boolean;
  durationMs: number;
  details?: string;
  error?: string;
}
