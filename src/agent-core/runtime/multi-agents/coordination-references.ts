type AgentIdentity = { id: string; parentSessionId?: string | null; title?: string };

export function agentAlias(session: AgentIdentity): string {
  return session.parentSessionId ? `@a-${session.id.slice(-10)}` : '@root';
}

export function agentReference(session: AgentIdentity): string {
  return session.parentSessionId && session.title ? `@${session.title}` : agentAlias(session);
}

export function runAlias(id: string): string {
  return `r-${id.slice(-10)}`;
}

