import { tr } from '../../i18n';
import type { JSONContent } from '@tiptap/vue-3';

import type { AgentComposerDocument, AgentComposerNode } from '../types';

export function createEmptyAgentComposer(): AgentComposerDocument {
  return { version: 1, nodes: [] };
}

function appendText(nodes: AgentComposerNode[], text: string) {
  if (!text) return;
  const previous = nodes.at(-1);
  if (previous?.type === 'text') previous.text += text;
  else nodes.push({ type: 'text', text });
}

export function composerDocumentFromJson(json: JSONContent): AgentComposerDocument {
  const nodes: AgentComposerNode[] = [];
  const blocks = json.content || [];

  blocks.forEach((block, blockIndex) => {
    if (blockIndex > 0) appendText(nodes, '\n');
    for (const child of block.content || []) {
      if (child.type === 'text') {
        appendText(nodes, child.text || '');
      } else if (child.type === 'hardBreak') {
        appendText(nodes, '\n');
      } else if (child.type === 'skillReference') {
        nodes.push({
          type: 'skill',
          id: String(child.attrs?.id || ''),
          name: String(child.attrs?.name || 'Skill'),
          scope: String(child.attrs?.scope || ''),
        });
      } else if (child.type === 'mcpServerReference') {
        nodes.push({
          type: 'mcp_server',
          name: String(child.attrs?.name || ''),
        });
      } else if (child.type === 'workspaceFileReference') {
        nodes.push({
          type: 'workspace_file',
          path: String(child.attrs?.path || ''),
          name: String(child.attrs?.name || tr('ui.files')),
        });
      }
    }
  });

  return { version: 1, nodes };
}

export function composerDocumentToJson(document: AgentComposerDocument): JSONContent {
  const content: JSONContent[] = [];

  for (const node of document.nodes) {
    if (node.type === 'skill') {
      content.push({
        type: 'skillReference',
        attrs: { id: node.id, name: node.name, scope: node.scope },
      });
      continue;
    }
    if (node.type === 'mcp_server') {
      content.push({ type: 'mcpServerReference', attrs: { name: node.name } });
      continue;
    }
    if (node.type === 'workspace_file') {
      content.push({
        type: 'workspaceFileReference',
        attrs: { path: node.path, name: node.name },
      });
      continue;
    }

    const lines = node.text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) content.push({ type: 'hardBreak' });
      if (line) content.push({ type: 'text', text: line });
    });
  }

  return {
    type: 'doc',
    content: [{ type: 'paragraph', content }],
  };
}

export function composerPlainText(document: AgentComposerDocument) {
  return document.nodes
    .map((node) => {
      if (node.type === 'text') return node.text;
      if (node.type === 'skill') return `/${node.name}`;
      if (node.type === 'mcp_server') return `/mcp:${node.name}`;
      return `@${node.name}`;
    })
    .join('');
}
