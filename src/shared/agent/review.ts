export interface ReviewLine {
  kind: 'context' | 'added' | 'removed' | 'gap';
  text: string;
  oldLine?: number;
  newLine?: number;
}
export interface ReviewFile {
  id: string;
  path: string;
  additions: number;
  deletions: number;
  unavailable: boolean;
}
export interface SessionReview {
  runId: string | null;
  files: ReviewFile[];
  lines?: ReviewLine[];
}
