import { tr } from '../i18n';
import { mergeAttributes, Node } from '@tiptap/vue-3';

export const SkillReference = Node.create({
  name: 'skillReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: { default: '' },
      name: { default: '' },
      scope: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-reference="skill"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-reference': 'skill',
        class: 'agent-composer-reference agent-composer-skill',
      }),
      `/${String(HTMLAttributes.name || 'Skill')}`,
    ];
  },

  renderText({ node }) {
    return `/${String(node.attrs.name || 'Skill')}`;
  },
});

export const McpServerReference = Node.create({
  name: 'mcpServerReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { name: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-reference="mcp-server"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-reference': 'mcp-server',
        class: 'agent-composer-reference agent-composer-mcp',
      }),
      `/mcp:${String(HTMLAttributes.name || 'MCP')}`,
    ];
  },

  renderText({ node }) {
    return `/mcp:${String(node.attrs.name || 'MCP')}`;
  },
});

export const WorkspaceFileReference = Node.create({
  name: 'workspaceFileReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      path: { default: '' },
      name: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-composer-reference="workspace-file"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-composer-reference': 'workspace-file',
        class: 'agent-composer-reference agent-composer-file',
      }),
      `@${String(HTMLAttributes.name || tr('ui.files'))}`,
    ];
  },

  renderText({ node }) {
    return `@${String(node.attrs.name || tr('ui.files'))}`;
  },
});
