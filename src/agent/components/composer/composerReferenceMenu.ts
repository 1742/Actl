import type { RuntimeMcpCatalogServer, RuntimeSkill, RuntimeWorkspaceFile } from '../../types';

export type ComposerMenuCandidate =
  | { key: string; type: 'attachment' }
  | { key: string; type: 'recent-chats' }
  | { key: string; type: 'compress' }
  | { key: string; type: 'mcp' }
  | { key: string; type: 'skill'; item: RuntimeSkill }
  | { key: string; type: 'mcp_server'; item: RuntimeMcpCatalogServer }
  | { key: string; type: 'file'; item: RuntimeWorkspaceFile };

export const ATTACHMENT_ACTION_KEY = 'action:attachment';
export const RECENT_CHATS_ACTION_KEY = 'action:recent-chats';
export const COMPRESS_ACTION_KEY = 'action:compress';
export const MCP_ACTION_KEY = 'action:mcp';
