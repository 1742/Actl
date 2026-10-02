import { tr } from '../../i18n';
import type {
  AIFunctionCallItem,
  AIFunctionCallOutputItem,
  AIMessageItem,
  AIReasoningItem,
  AIResponseContext,
  AIResponseOutputItem,
  AIWebSearchCallItem,
  AIUnknownOutputItem,
} from '../types/aiResponse';
import { normalizeResponseContext, readContentText } from './aiResponse';
import type {
  AgentComposerDocument,
  AgentInputContent,
  AgentResponse,
  AgentOutputBlock,
  AgentToolPresentation,
  AgentToolResultEnvelope,
  AgentToolStatus,
  PermissionRequestItem,
  ResolvedAgentComposer,
  RuntimeSkill,
} from '../types';

const toolPresentations: Readonly<Record<string, AgentToolPresentation>> = {
  shell: 'shell',
  shell_start: 'shell', // Keep rendering historical tool calls from existing conversations.
  shell_poll: 'process',
  shell_stop: 'process',
  read_file: 'read',
  read_uploaded_file: 'read',
  read_skill_resource: 'skill',
  write_file: 'write',
  apply_patch: 'edit',
  list_directory: 'list',
  search_files: 'glob',
  search_content: 'grep',
  move_path: 'move',
  delete_path: 'delete',
  run_skill_script: 'skill',
  web_search: 'web',
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function parseToolArguments(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseToolResult(value: unknown): AgentToolResultEnvelope {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: true, output: value, raw: value };
    }
  }
  const envelope = asRecord(parsed);
  if (!envelope || typeof envelope.ok !== 'boolean') {
    return { ok: true, output: parsed, raw: value };
  }
  return {
    ok: envelope.ok,
    ...(Object.hasOwn(envelope, 'output') ? { output: envelope.output } : {}),
    ...(typeof envelope.error === 'string' ? { error: envelope.error } : {}),
    raw: value,
  };
}

function isPermissionItem(
  item: AIResponseOutputItem,
): item is AIResponseOutputItem & PermissionRequestItem {
  return item.type === 'permission_request';
}

function toolStatus(
  context: AIResponseContext,
  call: AIFunctionCallItem,
  result: AgentToolResultEnvelope | undefined,
  permission: PermissionRequestItem | undefined,
): AgentToolStatus {
  if (permission?.status === 'pending') return 'waiting_permission';
  if (permission?.status === 'denied' || result?.ok === false) return 'error';
  if (result?.ok) return 'success';
  if (call.status === 'in_progress') return 'preparing';
  if (['completed', 'failed', 'incomplete', 'cancelled'].includes(context.response.status))
    return 'incomplete';
  return 'running';
}

export function buildAgentOutputBlocks(context: AIResponseContext): AgentOutputBlock[] {
  const outputs = context.response.output;
  const results = new Map<string, AIFunctionCallOutputItem>();
  const permissions = new Map<string, PermissionRequestItem>();

  for (const item of outputs) {
    if (
      item.type === 'function_call_output' &&
      'call_id' in item &&
      typeof item.call_id === 'string'
    ) {
      results.set(item.call_id, item as AIFunctionCallOutputItem);
    } else if (isPermissionItem(item) && typeof item.call_id === 'string') {
      permissions.set(item.call_id, item as unknown as PermissionRequestItem);
    }
  }

  return outputs.flatMap((item, index): AgentOutputBlock[] => {
    const key = item.id || `${context.response.id}:${item.type}:${index}`;
    if (item.type === 'message' && 'content' in item) {
      return [{ type: 'message', key, item: item as AIMessageItem }];
    }
    if (item.type === 'reasoning' && 'summary' in item) {
      return [{ type: 'reasoning', key, item: item as AIReasoningItem }];
    }
    if (item.type === 'function_call' && 'arguments' in item) {
      const call = item as AIFunctionCallItem;
      const callId = call.call_id || call.id || key;
      const resultItem = results.get(callId);
      const result = resultItem ? parseToolResult(resultItem.output) : undefined;
      const permission = permissions.get(callId);
      return [
        {
          type: 'tool',
          key,
          call,
          ...(resultItem ? { resultItem } : {}),
          ...(permission ? { permission } : {}),
          presentation: toolPresentations[call.name] || 'generic',
          arguments: parseToolArguments(call.arguments),
          ...(result ? { result } : {}),
          status: toolStatus(context, call, result, permission),
        },
      ];
    }
    if (item.type === 'function_call_output') return [];
    if (item.type === 'web_search_call' && 'action' in item) {
      return [{ type: 'web_search', key, item: item as AIWebSearchCallItem }];
    }
    if (isPermissionItem(item)) {
      return permissions.has(item.call_id) &&
        outputs.some(
          (candidate) =>
            candidate.type === 'function_call' &&
            'call_id' in candidate &&
            candidate.call_id === item.call_id,
        )
        ? []
        : [{ type: 'permission', key, item: item as unknown as PermissionRequestItem }];
    }
    return [
      {
        type: 'unknown',
        key,
        item: { ...item, raw: 'raw' in item ? item.raw : { ...item } } as AIUnknownOutputItem,
      },
    ];
  });
}

export type AgentOutputGroup =
  | { type: 'activity'; key: string; blocks: Exclude<AgentOutputBlock, { type: 'message' }>[] }
  | { type: 'message'; key: string; item: AIMessageItem; isFinal: boolean };

/** The visible summary of an output item, used by collapsed activity headers. */
export function agentOutputHint(block: Exclude<AgentOutputBlock, { type: 'message' }>): string {
  if (block.type === 'reasoning') {
    return block.item.status === 'in_progress'
      ? readContentText(block.item.summary) || tr('ui.thinking')
      : tr('ui.thought');
  }
  if (block.type === 'web_search') {
    const action = block.item.action;
    if (action.type === 'search')
      return tr('dynamic.searchingWeb', {
        query: action.queries?.join(', ') || tr('ui.webSearch'),
      });
    if (action.type === 'open_page')
      return tr('dynamic.openingWebPage', { url: action.url || '' }).trim();
    return tr('dynamic.findingWebPage', { pattern: action.pattern || action.url || '' }).trim();
  }
  if (block.type === 'permission') {
    if (block.item.status === 'pending') return tr('status.waitingToolPermission');
    return block.item.status === 'approved'
      ? tr('status.accessAllowed')
      : tr('status.accessDenied');
  }
  if (block.type === 'unknown') return tr('dynamic.unknownOutput', { type: block.item.type });

  const args = block.arguments;
  const stringArg = (key: string) => (typeof args?.[key] === 'string' ? (args[key] as string) : '');
  const labels: Record<AgentToolPresentation, string> = {
    shell: 'Shell',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    list: 'List',
    glob: 'Glob',
    grep: 'Grep',
    move: 'Move',
    delete: 'Delete',
    process: 'Process',
    skill: 'Skill',
    web: 'Search',
    generic: 'Tool',
  };
  let detail: string;
  switch (block.presentation) {
    case 'shell':
    case 'process':
      detail = stringArg('command') || stringArg('processId');
      break;
    case 'read':
    case 'write':
    case 'delete':
      detail = stringArg('path') || stringArg('file_id');
      break;
    case 'list':
      detail = stringArg('path') || '.';
      break;
    case 'glob':
      detail = stringArg('pattern');
      break;
    case 'grep':
      detail = [stringArg('pattern'), stringArg('path')].filter(Boolean).join(' in ');
      break;
    case 'move':
      detail = [stringArg('source'), stringArg('destination')].filter(Boolean).join(' → ');
      break;
    case 'skill':
      detail = stringArg('path') || stringArg('skillId');
      break;
    case 'web':
      detail = stringArg('query');
      break;
    case 'edit': {
      const patches = args?.patches;
      detail = Array.isArray(patches)
        ? patches
            .map((patch: unknown) => {
              if (!patch || typeof patch !== 'object' || !('path' in patch)) return '';
              return typeof patch.path === 'string' ? patch.path : '';
            })
            .filter(Boolean)
            .join(', ')
        : '';
      break;
    }
    default:
      detail = block.call.name;
  }
  return [labels[block.presentation], detail].filter(Boolean).join(' · ');
}

/** Groups execution activity between assistant messages for compact rendering. */
export function buildAgentOutputGroups(context: AIResponseContext): AgentOutputGroup[] {
  const groups: AgentOutputGroup[] = [];
  let activity: Exclude<AgentOutputBlock, { type: 'message' }>[] = [];
  let activityIndex = 0;
  const flushActivity = () => {
    if (!activity.length) return;
    groups.push({
      type: 'activity',
      key: `${context.response.id}:activity:${activityIndex++}`,
      blocks: activity,
    });
    activity = [];
  };
  for (const block of buildAgentOutputBlocks(context)) {
    if (block.type === 'message') {
      flushActivity();
      groups.push({ type: 'message', key: block.key, item: block.item, isFinal: false });
    } else {
      activity.push(block);
    }
  }
  flushActivity();
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.type === 'message') {
      group.isFinal = true;
      break;
    }
  }
  return groups;
}

export function agentResponseToContext(response: AgentResponse): AIResponseContext {
  return normalizeResponseContext({
    session_id: response.session_id,
    input: response.input,
    response,
    created_at: response.created_at,
    updated_at: response.updated_at,
    completed_at: response.completed_at,
  });
}

export function agentResponsesToContexts(responses: AgentResponse[]) {
  return responses.map(agentResponseToContext);
}

export function projectName(cwd: string, name?: string) {
  if (name?.trim()) return name.trim();
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || cwd || tr('ui.untitledProject');
}

export function conversationName(title?: string) {
  return title?.trim() || tr('ui.newConversation');
}

export function resolveAgentComposer(document: AgentComposerDocument): ResolvedAgentComposer {
  const content: AgentInputContent[] = [];
  const skillIds = new Set<string>();
  const mcpServers = new Set<string>();

  const appendText = (text: string) => {
    if (!text.trim()) return;
    const previous = content.at(-1);
    if (previous?.type === 'input_text') previous.text += text;
    else content.push({ type: 'input_text', text });
  };

  for (const node of document.nodes) {
    if (node.type === 'text') {
      appendText(node.text);
      continue;
    }

    if (node.type === 'workspace_file') {
      const path = node.path.trim();
      if (!path) return { content: [], error: tr('ui.invalidWorkspaceFileReference') };
      content.push({ type: 'input_workspace_file', path });
      continue;
    }

    if (node.type === 'mcp_server') {
      const name = node.name.trim();
      if (!name) return { content: [], error: tr('ui.invalidMcpReference') };
      if (mcpServers.has(name)) return { content: [], error: tr('dynamic.duplicateMcp', { name }) };
      if (mcpServers.size >= 8) return { content: [], error: tr('ui.mcpReferenceLimit') };
      mcpServers.add(name);
      content.push({ type: 'input_mcp_server', name });
      continue;
    }

    const id = node.id.trim();
    if (!id) return { content: [], error: tr('ui.invalidSkillReference') };
    if (skillIds.has(id))
      return { content: [], error: tr('dynamic.duplicateSkill', { name: node.name }) };
    if (skillIds.size >= 8) return { content: [], error: tr('ui.skillReferenceLimit') };
    skillIds.add(id);
    content.push({ type: 'input_skill', id, name: node.name });
  }

  return content.length ? { content } : { content: [], error: tr('ui.enterAMessageOrAddA') };
}

export function inputContentSummary(
  content: readonly AgentInputContent[],
  skills: readonly RuntimeSkill[] = [],
) {
  const skillNames = new Map(skills.map((skill) => [skill.id, skill.name]));
  return content
    .map((part) => {
      if (part.type === 'input_text') return part.text;
      if (part.type === 'input_file') return `@${part.filename || part.file_id}`;
      if (part.type === 'input_workspace_file')
        return `@${part.path.split('/').at(-1) || part.path}`;
      if (part.type === 'input_mcp_server') return `/mcp:${part.name}`;
      return `/${skillNames.get(part.id) || part.id}`;
    })
    .join('');
}

export function titleFromInput(
  content: readonly AgentInputContent[],
  skills: readonly RuntimeSkill[] = [],
) {
  const oneLine = inputContentSummary(content, skills).trim().replace(/\s+/g, ' ');
  return oneLine.length > 30 ? `${oneLine.slice(0, 30)}…` : oneLine;
}
