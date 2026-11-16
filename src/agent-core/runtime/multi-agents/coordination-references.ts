export function agentAlias(session: { id: string; parentSessionId?: string | null }): string {
  return session.parentSessionId ? `@a-${session.id.slice(-10)}` : '@root';
}

export function runAlias(id: string): string {
  return `r-${id.slice(-10)}`;
}

