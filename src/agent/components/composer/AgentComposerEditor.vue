<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import {
  McpServerReference,
  SkillReference,
  WorkspaceFileReference,
} from '../../composerExtensions';
import {
  composerDocumentFromJson,
  composerDocumentToJson,
} from '../../composables/useAgentComposer';
import type {
  AgentComposerDocument,
  AgentRuntimeKind,
  RuntimeSkill,
  RuntimeMcpCatalogServer,
  RuntimeWorkspaceFile,
} from '../../types';
import ComposerReferenceMenu from './ComposerReferenceMenu.vue';
import {
  ATTACHMENT_ACTION_KEY,
  COMPRESS_ACTION_KEY,
  MCP_ACTION_KEY,
  RECENT_CHATS_ACTION_KEY,
  type ComposerMenuCandidate,
} from './composerReferenceMenu';

interface TriggerRange {
  from: number;
  to: number;
}

interface ReferenceMenu {
  type: 'skill' | 'file';
  query: string;
  range: TriggerRange;
}

const props = withDefaults(
  defineProps<{
    modelValue: AgentComposerDocument;
    skills: RuntimeSkill[];
    skillsLoading?: boolean;
    skillsError?: string;
    projectId?: string;
    runtimeKind: AgentRuntimeKind;
    placeholder?: string;
    disabled?: boolean;
    menuOffset?: number;
    attachmentActionDisabled?: boolean;
    compressionAvailable?: boolean;
    compressionPercent?: number;
  }>(),
  {
    skillsLoading: false,
    skillsError: '',
    projectId: '',
    placeholder: '',
    disabled: false,
    menuOffset: 0,
    attachmentActionDisabled: false,
    compressionAvailable: false,
    compressionPercent: 0,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: AgentComposerDocument];
  submit: [];
  addAttachments: [];
  openRecentChats: [];
  compressContext: [];
  pasteImages: [files: File[]];
}>();

const menu = ref<ReferenceMenu>();
const menuPanelRef = ref<InstanceType<typeof ComposerReferenceMenu>>();
const menuLevel = ref<'root' | 'mcp'>('root');
const mcpEntryQuery = ref('');
const activeKey = ref('');
const workspaceFiles = ref<RuntimeWorkspaceFile[]>([]);
const mcpServers = ref<RuntimeMcpCatalogServer[]>([]);
const mcpLoading = ref(false);
const mcpError = ref('');
const filesLoading = ref(false);
const filesError = ref('');
const filesTruncated = ref(false);
let fileSearchTimer = 0;
let fileSearchVersion = 0;
let mcpLoadVersion = 0;

const selectedSkillIds = computed(
  () =>
    new Set(props.modelValue.nodes.filter((node) => node.type === 'skill').map((node) => node.id)),
);
const selectedMcpNames = computed(
  () =>
    new Set(
      props.modelValue.nodes.filter((node) => node.type === 'mcp_server').map((node) => node.name),
    ),
);

const filteredSkills = computed(() => {
  const query = menu.value?.type === 'skill' ? menu.value.query.toLocaleLowerCase() : '';
  return props.skills.filter(
    (skill) =>
      !query ||
      skill.name.toLocaleLowerCase().includes(query) ||
      skill.description.toLocaleLowerCase().includes(query),
  );
});
const filteredMcpServers = computed(() => {
  const query =
    menu.value?.type === 'skill' && menuLevel.value === 'mcp'
      ? menu.value.query.slice(mcpEntryQuery.value.length).toLocaleLowerCase()
      : '';
  return mcpServers.value.filter(
    (server) => !query || server.name.toLocaleLowerCase().includes(query),
  );
});
const mcpQuery = computed(() => menu.value?.query.slice(mcpEntryQuery.value.length) || '');

const skillLimitReached = computed(() => selectedSkillIds.value.size >= 8);
const candidates = computed<ComposerMenuCandidate[]>(() =>
  menu.value?.type === 'skill'
    ? menuLevel.value === 'root'
      ? [
          { key: ATTACHMENT_ACTION_KEY, type: 'attachment' as const },
          ...(props.compressionAvailable
            ? [{ key: COMPRESS_ACTION_KEY, type: 'compress' as const }]
            : []),
          { key: RECENT_CHATS_ACTION_KEY, type: 'recent-chats' as const },
          { key: MCP_ACTION_KEY, type: 'mcp' as const },
          ...filteredSkills.value.map((item) => ({ key: item.id, type: 'skill' as const, item })),
        ]
      : filteredMcpServers.value.map((item) => ({
          key: `mcp:${item.name}`,
          type: 'mcp_server' as const,
          item,
        }))
    : workspaceFiles.value.map((item) => ({ key: item.path, type: 'file' as const, item })),
);
const disabledKeys = computed(
  () =>
    new Set(
      candidates.value
        .filter((candidate) => !isAvailableCandidate(candidate))
        .map((candidate) => candidate.key),
    ),
);

function closeMenu() {
  menu.value = undefined;
  menuLevel.value = 'root';
  mcpEntryQuery.value = '';
  activeKey.value = '';
}

function openReferenceMenu(type: 'skill' | 'file') {
  const currentEditor = editor.value;
  if (!currentEditor || !currentEditor.isEditable) return;
  currentEditor.commands.focus();
  const position = currentEditor.state.selection.from;
  menuLevel.value = 'root';
  mcpEntryQuery.value = '';
  menu.value = { type, query: '', range: { from: position, to: position } };
}

function openMcpMenu() {
  if (menu.value?.type !== 'skill') return;
  mcpEntryQuery.value = menu.value.query;
  menuLevel.value = 'mcp';
  activeKey.value = '';
}

function backToRootMenu() {
  menuLevel.value = 'root';
  mcpEntryQuery.value = '';
  activeKey.value = MCP_ACTION_KEY;
  void scrollActiveCandidateIntoView();
}

function refreshTrigger() {
  const currentEditor = editor.value;
  if (!currentEditor || !currentEditor.isEditable) {
    closeMenu();
    return;
  }

  const { $from } = currentEditor.state.selection;
  if (!$from.parent.isTextblock) {
    closeMenu();
    return;
  }

  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\uFFFC');
  const match = before.match(/(?:^|[\s\uFFFC])([/@])([^\s/@]*)$/);
  if (!match) {
    closeMenu();
    return;
  }

  const query = match[2] || '';
  const type = match[1] === '/' ? 'skill' : 'file';
  if (type !== 'skill' || (menuLevel.value === 'mcp' && !query.startsWith(mcpEntryQuery.value))) {
    menuLevel.value = 'root';
    mcpEntryQuery.value = '';
  }
  menu.value = {
    type,
    query,
    range: {
      from: currentEditor.state.selection.from - query.length - 1,
      to: currentEditor.state.selection.from,
    },
  };
}

function updateDocument() {
  if (!editor.value) return;
  emit('update:modelValue', composerDocumentFromJson(editor.value.getJSON()));
  refreshTrigger();
}

function canSelectSkill(skill: RuntimeSkill) {
  if (!skill.available || selectedSkillIds.value.has(skill.id)) return false;
  return !skillLimitReached.value;
}

function selectSkill(skill: RuntimeSkill) {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'skill' || !canSelectSkill(skill)) return;
  editor.value
    ?.chain()
    .focus()
    .deleteRange(currentMenu.range)
    .insertContent([
      {
        type: 'skillReference',
        attrs: {
          id: skill.id,
          name: skill.name,
          scope: skill.source.scope,
        },
      },
      { type: 'text', text: ' ' },
    ])
    .run();
  closeMenu();
}

function canSelectMcpServer(server: RuntimeMcpCatalogServer) {
  return (
    server.connected &&
    server.toolCount > 0 &&
    !selectedMcpNames.value.has(server.name) &&
    selectedMcpNames.value.size < 8
  );
}

function selectMcpServer(server: RuntimeMcpCatalogServer) {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'skill' || !canSelectMcpServer(server)) return;
  editor.value
    ?.chain()
    .focus()
    .deleteRange(currentMenu.range)
    .insertContent([
      { type: 'mcpServerReference', attrs: { name: server.name } },
      { type: 'text', text: ' ' },
    ])
    .run();
  closeMenu();
}

function selectWorkspaceFile(file: RuntimeWorkspaceFile) {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'file' || !props.projectId) return;
  editor.value
    ?.chain()
    .focus()
    .deleteRange(currentMenu.range)
    .insertContent([
      {
        type: 'workspaceFileReference',
        attrs: { path: file.path, name: file.name },
      },
      { type: 'text', text: ' ' },
    ])
    .run();
  closeMenu();
}

function selectAttachmentAction() {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'skill' || props.attachmentActionDisabled) return;
  editor.value?.chain().focus().deleteRange(currentMenu.range).run();
  closeMenu();
  emit('addAttachments');
}

function selectRecentChatsAction() {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'skill') return;
  editor.value?.chain().focus().deleteRange(currentMenu.range).run();
  closeMenu();
  emit('openRecentChats');
}

function selectCompressionAction() {
  const currentMenu = menu.value;
  if (!currentMenu || currentMenu.type !== 'skill' || !props.compressionAvailable) return;
  editor.value?.chain().focus().deleteRange(currentMenu.range).run();
  closeMenu();
  emit('compressContext');
}

function selectActiveCandidate() {
  const candidate = candidates.value.find((item) => item.key === activeKey.value);
  if (!candidate) return;
  selectCandidate(candidate);
}

function selectCandidate(candidate: ComposerMenuCandidate) {
  if (candidate.type === 'attachment') selectAttachmentAction();
  else if (candidate.type === 'recent-chats') selectRecentChatsAction();
  else if (candidate.type === 'compress') selectCompressionAction();
  else if (candidate.type === 'mcp') openMcpMenu();
  else if (candidate.type === 'skill') selectSkill(candidate.item);
  else if (candidate.type === 'mcp_server') selectMcpServer(candidate.item);
  else selectWorkspaceFile(candidate.item);
}

function isAvailableCandidate(candidate: ComposerMenuCandidate) {
  if (candidate.type === 'attachment') return !props.attachmentActionDisabled;
  if (candidate.type === 'skill') return canSelectSkill(candidate.item);
  if (candidate.type === 'mcp_server') return canSelectMcpServer(candidate.item);
  return true;
}

function moveActive(direction: 1 | -1) {
  const available = candidates.value.filter(isAvailableCandidate);
  if (!available.length) return;
  const index = available.findIndex((candidate) => candidate.key === activeKey.value);
  const next =
    index < 0
      ? direction > 0
        ? 0
        : available.length - 1
      : (index + direction + available.length) % available.length;
  activeKey.value = available[next].key;
  void scrollActiveCandidateIntoView();
}

async function scrollActiveCandidateIntoView() {
  await menuPanelRef.value?.scrollToCandidate(activeKey.value);
}

const editor = useEditor({
  content: composerDocumentToJson(props.modelValue),
  extensions: [
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
    }),
    Placeholder.configure({ placeholder: () => props.placeholder }),
    SkillReference,
    McpServerReference,
    WorkspaceFileReference,
  ],
  editable: !props.disabled,
  editorProps: {
    attributes: {
      class: 'agent-composer-content',
      role: 'textbox',
      'aria-multiline': 'true',
    },
    handlePaste: (_view, event) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return false;

      const itemImages = Array.from(clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
        .flatMap((item) => {
          const file = item.getAsFile();
          return file ? [file] : [];
        });
      const imageFiles = itemImages.length
        ? itemImages
        : Array.from(clipboardData.files).filter((file) =>
            file.type.toLowerCase().startsWith('image/'),
          );
      if (!imageFiles.length) return false;

      event.preventDefault();
      closeMenu();
      emit('pasteImages', imageFiles);
      return true;
    },
    handleKeyDown: (_view, event) => {
      if (event.isComposing) return false;
      if (menu.value) {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (menuLevel.value === 'mcp') backToRootMenu();
          else closeMenu();
          return true;
        }
        if (event.key === 'ArrowLeft' && menuLevel.value === 'mcp') {
          event.preventDefault();
          backToRootMenu();
          return true;
        }
        if (event.key === 'ArrowRight' && activeKey.value === MCP_ACTION_KEY) {
          event.preventDefault();
          openMcpMenu();
          return true;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveActive(event.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (activeKey.value) selectActiveCandidate();
          return true;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        emit('submit');
        return true;
      }
      return false;
    },
  },
  onUpdate: updateDocument,
  onSelectionUpdate: refreshTrigger,
});

watch(
  () => props.disabled,
  (disabled) => editor.value?.setEditable(!disabled),
);

watch(
  () => JSON.stringify(props.modelValue),
  () => {
    const currentEditor = editor.value;
    if (!currentEditor) return;
    const current = composerDocumentFromJson(currentEditor.getJSON());
    if (JSON.stringify(current) === JSON.stringify(props.modelValue)) return;
    currentEditor.commands.setContent(composerDocumentToJson(props.modelValue), {
      emitUpdate: false,
    });
    closeMenu();
  },
);

watch(
  candidates,
  (items) => {
    if (!items.some((item) => item.key === activeKey.value)) {
      const first = items.find(isAvailableCandidate);
      activeKey.value = first?.key || '';
    }
  },
  { immediate: true },
);

watch(
  () => menu.value?.type,
  (type) => {
    if (type !== 'skill') {
      mcpLoadVersion += 1;
      return;
    }
    const version = ++mcpLoadVersion;
    mcpLoading.value = true;
    mcpError.value = '';
    mcpServers.value = [];
    const { client } = getAgentRuntimeContext(props.runtimeKind);
    void client
      .listMcpCatalog()
      .then((servers) => {
        if (version === mcpLoadVersion) mcpServers.value = servers;
      })
      .catch((error: unknown) => {
        if (version === mcpLoadVersion)
          mcpError.value = error instanceof Error ? error.message : tr('ui.failedToLoadTheMcpList');
      })
      .finally(() => {
        if (version === mcpLoadVersion) mcpLoading.value = false;
      });
  },
);

watch(
  [() => menu.value?.type, () => menu.value?.query, () => props.projectId],
  ([type, query, projectId]) => {
    if (fileSearchTimer) window.clearTimeout(fileSearchTimer);
    if (type !== 'file') return;

    workspaceFiles.value = [];
    filesError.value = '';
    filesTruncated.value = false;
    if (!projectId) return;

    const requestVersion = ++fileSearchVersion;
    filesLoading.value = true;
    fileSearchTimer = window.setTimeout(async () => {
      try {
        const { client } = getAgentRuntimeContext(props.runtimeKind);
        const result = await client.searchWorkspaceFiles(projectId, query || '');
        if (requestVersion !== fileSearchVersion) return;
        workspaceFiles.value = result.data;
        filesTruncated.value = result.truncated;
      } catch (error) {
        if (requestVersion !== fileSearchVersion) return;
        filesError.value =
          error instanceof Error ? error.message : tr('ui.failedToSearchWorkspaceFiles');
      } finally {
        if (requestVersion === fileSearchVersion) filesLoading.value = false;
      }
    }, 180);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (fileSearchTimer) window.clearTimeout(fileSearchTimer);
  fileSearchVersion += 1;
  mcpLoadVersion += 1;
});

defineExpose({
  focus: () => editor.value?.commands.focus(),
  openReferenceMenu,
});
</script>

<template>
  <div class="relative min-h-12 w-full">
    <ComposerReferenceMenu
      v-if="menu"
      ref="menuPanelRef"
      class="absolute -left-4 z-30 flex max-h-[min(19rem,42vh)] w-[calc(100%+2rem)] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white"
      :style="{ bottom: `calc(100% + 1.5rem + ${menuOffset}px)` }"
      :type="menu.type"
      :level="menuLevel"
      :query="menuLevel === 'mcp' ? mcpQuery : menu.query"
      :candidates="candidates"
      :active-key="activeKey"
      :disabled-keys="disabledKeys"
      :selected-skill-ids="selectedSkillIds"
      :selected-mcp-names="selectedMcpNames"
      :selected-skill-count="selectedSkillIds.size"
      :selected-mcp-count="selectedMcpNames.size"
      :mcp-server-count="mcpServers.length"
      :skills-loading="skillsLoading"
      :skills-error="skillsError"
      :mcp-loading="mcpLoading"
      :mcp-error="mcpError"
      :project-id="projectId"
      :files-loading="filesLoading"
      :files-error="filesError"
      :files-truncated="filesTruncated"
      :compression-percent="compressionPercent"
      @active="activeKey = $event"
      @select="selectCandidate"
      @back="backToRootMenu"
    />

    <EditorContent :editor="editor" />
  </div>
</template>

<style scoped>
@reference "tailwindcss";

:deep(.agent-composer-content) {
  @apply max-h-45 min-h-12 w-full overflow-y-auto bg-transparent px-1 py-1 text-[15px] leading-relaxed text-gray-800 outline-none;
}

:deep(.agent-composer-content p) {
  @apply m-0 min-h-7;
}

:deep(.agent-composer-content p.is-editor-empty:first-child::before) {
  @apply pointer-events-none float-left h-0 text-gray-400;
  content: attr(data-placeholder);
}

:deep(.agent-composer-reference) {
  @apply inline-flex cursor-default select-none items-center gap-1 align-baseline font-medium leading-5;
}

:deep(.agent-composer-skill),
:deep(.agent-composer-mcp) {
  color: color-mix(in srgb, var(--color-primary) 65%, var(--color-gray-900));
}

:deep(.agent-composer-file) {
  color: color-mix(in srgb, var(--color-primary) 65%, var(--color-gray-900));
}

:deep(.ProseMirror-selectednode) {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 30%, transparent);
}
</style>
