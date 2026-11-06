import { tr } from '../../i18n';
import type {
  AIFileContent,
  AIMessageItem,
  AIResponse,
  AIResponseContent,
  AIResponseContext,
  AIResponseInputItem,
  AIResponseOutputItem,
  AIResponseStatus,
  AIResponseUsage,
  AISkillContent,
  AIMcpServerContent,
  AIWebSearchCallItem,
  AIWorkspaceFileContent,
} from '../types/aiResponse';

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asString = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function normalizeContent(source: unknown): AIResponseContent {
  const raw = asRecord(source);
  const type = asString(raw.type, 'unknown');
  if (type === 'input_text' || type === 'output_text' || type === 'summary_text') {
    return { ...raw, type, text: asString(raw.text), annotations: asArray(raw.annotations) };
  }
  if (type === 'refusal') return { ...raw, type, refusal: asString(raw.refusal ?? raw.text) };
  if (type === 'input_file') {
    return {
      ...raw,
      type,
      bytes:
        typeof raw.bytes === 'number'
          ? raw.bytes
          : typeof raw.size === 'number'
            ? raw.size
            : undefined,
      mime_type: asString(raw.mime_type ?? raw.media_type) || undefined,
    } as AIFileContent;
  }
  if (type === 'input_workspace_file') {
    return { ...raw, type, path: asString(raw.path) } as AIWorkspaceFileContent;
  }
  if (type === 'input_skill') {
    return {
      ...raw,
      type,
      id: asString(raw.id),
      name: asString(raw.name) || undefined,
    } as AISkillContent;
  }
  if (type === 'input_mcp_server') {
    return { ...raw, type, name: asString(raw.name) } as AIMcpServerContent;
  }
  return { ...raw, type };
}

export function normalizeResponseItem(source: unknown): AIResponseOutputItem {
  const raw = asRecord(source);
  const type = asString(raw.type, 'unknown');
  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (type === 'message') {
    const role = ['user', 'assistant', 'system', 'developer'].includes(asString(raw.role))
      ? (asString(raw.role) as AIMessageItem['role'])
      : 'assistant';
    return { ...raw, type, id, role, content: asArray(raw.content).map(normalizeContent) };
  }
  if (type === 'reasoning') {
    return {
      ...raw,
      type,
      id,
      summary: asArray(raw.summary).map(normalizeContent),
      content: asArray(raw.content).map(normalizeContent),
    };
  }
  if (type === 'function_call') {
    return { ...raw, type, id, name: asString(raw.name), arguments: asString(raw.arguments) };
  }
  if (type === 'function_call_output') {
    return { ...raw, type, id, output: raw.output };
  }
  if (type === 'web_search_call') {
    const rawAction = asRecord(raw.action);
    const actionType = ['search', 'open_page', 'find_in_page'].includes(asString(rawAction.type))
      ? (asString(rawAction.type) as AIWebSearchCallItem['action']['type'])
      : 'search';
    const queries = asArray(rawAction.queries).filter(
      (query): query is string => typeof query === 'string',
    );
    const sources = asArray(rawAction.sources).flatMap((source) => {
      const entry = asRecord(source);
      return entry.type === 'url' && typeof entry.url === 'string'
        ? [{ type: 'url' as const, url: entry.url }]
        : [];
    });
    return {
      ...raw,
      type,
      id,
      action: {
        type: actionType,
        ...(queries.length ? { queries } : {}),
        ...(typeof rawAction.url === 'string' ? { url: rawAction.url } : {}),
        ...(typeof rawAction.pattern === 'string' ? { pattern: rawAction.pattern } : {}),
        ...(sources.length ? { sources } : {}),
      },
    } as AIWebSearchCallItem;
  }
  return { ...raw, type, id, raw };
}

export function normalizeResponse(source: unknown): AIResponse {
  const raw = asRecord(source);
  const knownKeys = new Set([
    'id',
    'object',
    'status',
    'model',
    'previous_response_id',
    'previousResponseId',
    'output',
    'error',
    'incomplete_details',
    'incompleteDetails',
    'usage',
    'metadata',
  ]);
  const extensions = Object.fromEntries(Object.entries(raw).filter(([key]) => !knownKeys.has(key)));
  const error = asRecord(raw.error);
  const usage = asRecord(raw.usage);
  const normalizedUsage: AIResponseUsage | undefined = Object.keys(usage).length
    ? {
        inputTokens: Number(usage.input_tokens ?? usage.inputTokens) || undefined,
        outputTokens: Number(usage.output_tokens ?? usage.outputTokens) || undefined,
        totalTokens: Number(usage.total_tokens ?? usage.totalTokens) || undefined,
        raw: usage,
      }
    : undefined;
  return {
    id: asString(raw.id),
    object: 'response',
    status: asString(raw.status, 'in_progress') as AIResponseStatus,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    previousResponseId: asString(raw.previous_response_id ?? raw.previousResponseId) || undefined,
    output: asArray(raw.output).map(normalizeResponseItem),
    error: Object.keys(error).length
      ? {
          code: asString(error.code) || undefined,
          message: asString(error.message, 'AI response failed'),
          raw: error,
        }
      : undefined,
    incompleteDetails: raw.incomplete_details ?? raw.incompleteDetails,
    usage: normalizedUsage,
    metadata: Object.keys(asRecord(raw.metadata)).length ? asRecord(raw.metadata) : undefined,
    extensions: Object.keys(extensions).length ? extensions : undefined,
  };
}

export function normalizeResponseContext(source: unknown): AIResponseContext {
  const raw = asRecord(source);
  const responseSource = raw.response ?? raw;
  const normalizedResponse = normalizeResponse(responseSource);
  const now = new Date().toISOString();
  const createdAt = asString(raw.createdAt ?? raw.created_at, now);
  const updatedAt = asString(raw.updatedAt ?? raw.updated_at, createdAt);
  const completedAt = asString(raw.completedAt ?? raw.completed_at) || undefined;
  return {
    sessionId: asString(raw.sessionId ?? raw.session_id),
    input: asArray(raw.input).map(normalizeResponseItem) as AIResponseInputItem[],
    response: normalizedResponse,
    createdAt,
    updatedAt,
    completedAt,
  };
}

export function readContentText(
  parts?: readonly AIResponseContent[],
  contentType?: string,
): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => !contentType || part.type === contentType)
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

export function readInputContentDisplayText(
  parts?: readonly AIResponseContent[],
  skillNames: Readonly<Record<string, string>> = {},
) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (part.type === 'input_text') return part.text;
      if (part.type === 'input_skill') return `/${part.name || skillNames[part.id] || part.id}`;
      if (part.type === 'input_mcp_server') return `/mcp:${part.name}`;
      if (part.type === 'input_workspace_file') return `@${part.path}`;
      if (part.type === 'input_file') {
        const name = part.filename || part.name || part.asset_id || part.assetId || part.file_id;
        return `@${typeof name === 'string' ? name : tr('ui.files')}`;
      }
      return '';
    })
    .join('')
    .trim();
}

export function getFileParts(item: AIResponseInputItem): AIFileContent[] {
  if (
    item.type !== 'message' ||
    !('content' in item) ||
    !Array.isArray(item.content) ||
    item.role === 'assistant'
  )
    return [];
  return (item.content as AIResponseContent[]).filter(
    (part): part is AIFileContent => part.type === 'input_file',
  );
}
