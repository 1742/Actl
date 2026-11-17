export const MAX_AGENT_NAME_LENGTH = 120;

export function agentNameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function validAgentName(title: string | undefined): string | undefined {
  const name = title?.normalize('NFC').trim();
  if (!name || name.length > MAX_AGENT_NAME_LENGTH || /[\p{Cc}\u2028\u2029]/u.test(name)) return undefined;
  const key = agentNameKey(name);
  if (key.startsWith('@') || /^(root|parent|self|a-[\da-f]{10})$/.test(key)) return undefined;
  return name;
}

export function availableAgentName(suggested: string | undefined, usedKeys: ReadonlySet<string>): string {
  const base = validAgentName(suggested) ?? 'Agent';
  let name = base;
  for (let index = 2; usedKeys.has(agentNameKey(name)); index++) {
    const suffix = ` (${index})`;
    const prefix = base.slice(0, MAX_AGENT_NAME_LENGTH - suffix.length).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
    name = prefix + suffix;
  }
  return name;
}
