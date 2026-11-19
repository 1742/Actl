import { tr } from '../../../i18n';
import type { AgentOutputBlock, AgentToolTimelineBlock } from '../../components/conversation/types';
import { agentTeamCard, agentTeamCardKind, type AgentTeamCard } from './agentTeamCards';
import { webLinkHref, webSourcesFromOutput, webSourcesFromSearchCall, type AgentWebSource } from '../webSearch';

export type ToolBlock = Extract<AgentOutputBlock, { type: 'tool' | 'web_search' }>;
export interface WebSearchDetails {
  kind: 'web_search';
  searching: boolean;
  query: string;
  sources: AgentWebSource[];
  url?: string | undefined;
  href?: string | undefined;
}

type ToolDetails =
  | WebSearchDetails
  | { kind: 'error' | 'text' | 'web_fetch'; text: string }
  | { kind: 'team'; card: AgentTeamCard }
  | { kind: 'shell'; command: string; output: string }
  | { kind: 'patch'; patches: Array<{ path: string; replacements: Array<{ oldText: string; newText: string }> }> };

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function toolDetails(block: ToolBlock): ToolDetails | undefined {
  if (block.type === 'web_search') {
    const { action, status } = block.item;
    const searching = status === 'in_progress' || status === 'searching';
    return {
      kind: 'web_search', searching, query: action.type === 'search' ? action.queries?.join('、') || '' : '',
      sources: webSourcesFromSearchCall(block.item), url: searching ? undefined : action.url, href: webLinkHref(action.url),
    };
  }
  const args = block.arguments ?? {};
  const output = block.result?.output;
  const data = record(output);
  if (block.result?.error) return { kind: 'error', text: block.result.error };
  if (block.presentation === 'web_search') {
    return { kind: 'web_search', searching: ['preparing', 'running'].includes(block.status),
      query: text(args.query), sources: webSourcesFromOutput(output) };
  }
  const teamKind = agentTeamCardKind(block.call.name);
  if (teamKind) {
    const card = block.status !== 'error' && agentTeamCard(block, teamKind);
    return card ? { kind: 'team', card } : undefined;
  }
  switch (block.presentation) {
    case 'shell': {
      const command = text(args.command);
      const log = Array.isArray(data.output) && data.output.length
        ? records(data.output).map((chunk) => text(chunk.text)).join('')
        : [text(data.stdout), text(data.stderr)].filter(Boolean).join('\n');
      if (command || log) return { kind: 'shell', command, output: log };
      break;
    }
    case 'edit': {
      const patches = records(args.patches).map((patch) => ({
        path: text(patch.path),
        replacements: records(patch.replacements).map((row) => ({ oldText: text(row.oldText), newText: text(row.newText) })),
      }));
      if (patches.length) return { kind: 'patch', patches };
      break;
    }
    case 'read':
      if (text(data.content)) return { kind: 'text', text: text(data.content) };
      break;
    case 'write':
      if (text(args.content)) return { kind: 'text', text: text(args.content) };
      break;
    case 'web_fetch':
      if (block.status === 'success' && text(data.content)) return { kind: 'web_fetch', text: text(data.content) };
      break;
  }
  const value = formatOutput(output) || formatArguments(block.call.arguments);
  return value ? { kind: 'text', text: value } : undefined;
}

function formatOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function formatArguments(value: string): string {
  if (!value) return '';
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

export function toolResultHint(block: AgentToolTimelineBlock): string {
  switch (block.status) {
    case 'waiting_permission': return tr('ui.awaitingPermission');
    case 'preparing': return tr('ui.preparingArguments');
    case 'running': return tr('ui.runningEllipsis');
    case 'incomplete': return tr('ui.incomplete');
    case 'error': return block.result?.error || block.permission?.denial_reason || tr('ui.executionFailed');
  }
  const output = block.result?.output;
  const data = record(output);
  switch (block.presentation) {
    case 'write': {
      const content = text(block.arguments?.content);
      return content ? `${content.split(/\r?\n/).length} lines` : '';
    }
    case 'read':
      return typeof data.startLine === 'number' && typeof data.endLine === 'number' ? `Lines ${data.startLine}–${data.endLine}` : '';
    case 'shell':
      if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
      if (data.status === 'running') return tr('ui.runningInBackground');
      return typeof data.exitCode === 'number' ? `Exit code ${data.exitCode}` : tr('ui.completed');
    case 'edit':
      return typeof data.filesChanged === 'number' ? `${data.filesChanged} files changed` : '';
    case 'glob':
    case 'grep':
    case 'list': {
      const items = [data.entries, data.files, data.data, data.matches].find(Array.isArray);
      if (!items) return '';
      if (block.presentation === 'glob') return `Found ${items.length} files`;
      return `${items.length} ${block.presentation === 'grep' ? 'matches' : 'entries'}`;
    }
    default: return '';
  }
}
