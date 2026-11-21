export function powerShellArgs(command: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command];
}
