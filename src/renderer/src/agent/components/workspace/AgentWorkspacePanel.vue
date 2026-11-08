<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref, watch } from 'vue';
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from '@lucide/vue';

import { getAgentRuntimeContext } from '../../services/runtimeClient';
import type { ProjectWorkspace, RuntimeWorkspaceDirectoryEntry, RuntimeWorkspaceTree } from '../../../../../shared/agent/workspace';
import { useNotifyStore } from '../../../composables/notify';
import WorkspaceSelector from './WorkspaceSelector.vue';

const props = defineProps<{ projectId: string; workspaces: ProjectWorkspace[]; primaryWorkspaceId: string }>();
const emit = defineEmits<{ openFile: [workspaceId: string, entry: RuntimeWorkspaceDirectoryEntry] }>();
const selectedWorkspaceId = ref('');
const workspace = computed(() => props.workspaces.find(({ id }) => id === selectedWorkspaceId.value)
  ?? props.workspaces.find(({ id }) => id === props.primaryWorkspaceId));
const trees = ref(new Map<string, RuntimeWorkspaceTree>());
const expanded = ref(new Set<string>());
const loading = ref(new Set<string>());
const error = ref('');
const requestVersion = ref(0);
const openingProjectDirectory = ref(false);
const notify = useNotifyStore();

interface VisibleEntry {
  entry: RuntimeWorkspaceDirectoryEntry;
  depth: number;
}

const visibleEntries = computed<VisibleEntry[]>(() => {
  const result: VisibleEntry[] = [];
  const visit = (path: string, depth: number) => {
    const tree = trees.value.get(path);
    if (!tree) return;
    for (const entry of tree.entries) {
      result.push({ entry, depth });
      if (entry.type === 'directory' && expanded.value.has(entry.path))
        visit(entry.path, depth + 1);
    }
  };
  visit('.', 0);
  return result;
});

function isExpanded(path: string) {
  return expanded.value.has(path);
}

function isLoading(path: string) {
  return loading.value.has(path);
}

async function loadDirectory(path: string, force = false) {
  const workspaceId = workspace.value?.id;
  if (!props.projectId || !workspaceId || (trees.value.has(path) && !force) || loading.value.has(path)) return;
  const version = requestVersion.value;
  loading.value = new Set(loading.value).add(path);
  error.value = '';
  try {
    const { client } = getAgentRuntimeContext('local');
    const tree = await client.listWorkspaceDirectory(props.projectId, path, undefined, workspaceId);
    if (version !== requestVersion.value) return;
    const next = new Map(trees.value);
    next.set(path, tree);
    trees.value = next;
  } catch (cause) {
    if (version === requestVersion.value)
      error.value = cause instanceof Error ? cause.message : tr('ui.failedToLoadFileTree');
  } finally {
    if (version === requestVersion.value) loading.value.delete(path);
  }
}

async function toggleDirectory(path: string) {
  if (isExpanded(path)) {
    const next = new Set(expanded.value);
    next.delete(path);
    expanded.value = next;
    return;
  }
  expanded.value.add(path);
  await loadDirectory(path);
}

async function refresh() {
  trees.value = new Map();
  expanded.value = new Set();
  loading.value = new Set();
  error.value = '';
  requestVersion.value += 1;
  await loadDirectory('.', true);
}

async function openProjectDirectory() {
  const workspaceId = workspace.value?.id;
  if (!props.projectId || !workspaceId) return;
  openingProjectDirectory.value = true;
  try {
    await window.actlAgent.openProjectDirectory(props.projectId, workspaceId);
  } catch {
    notify.error(tr('ui.couldNotOpenFolder'));
  } finally {
    openingProjectDirectory.value = false;
  }
}

watch(() => workspace.value?.id, () => void refresh(), { immediate: true });

function openFile(entry: RuntimeWorkspaceDirectoryEntry) {
  if (workspace.value) emit('openFile', workspace.value.id, entry);
}
</script>

<template>
  <aside class="flex h-full min-h-0 w-full flex-col bg-white" :aria-label="$t('ui.workspaceFiles')">
    <header class="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-gray-600">
      <WorkspaceSelector
        v-if="workspace"
        :workspaces="workspaces"
        :selected="workspace"
        @select="selectedWorkspaceId = $event"
      />
      <span v-else>{{ $t('ui.files') }}</span>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex size-8 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm transition-colors enabled:hover:bg-gray-100 disabled:opacity-50"
          type="button"
          :aria-label="$t('ui.openWorkspaceDirectory')"
          :title="$t('ui.openWorkspaceDirectory')"
          :disabled="!workspace || openingProjectDirectory"
          @click="openProjectDirectory"
        >
          <FolderOpen :size="14" />
        </button>
        <button
          class="flex size-8 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm transition-colors enabled:hover:bg-gray-100 disabled:opacity-50"
          type="button"
          :aria-label="$t('ui.refreshFileTree')"
          :title="$t('ui.refresh')"
          :disabled="!workspace"
          @click="refresh"
        >
          <RefreshCw :size="14" />
        </button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
      <div v-if="!workspace" class="px-3 py-8 text-center text-xs text-gray-400">
        {{ $t('ui.thisConversationHasNoLocalProject') }}
      </div>
      <div
        v-else-if="isLoading('.') && !trees.has('.')"
        class="flex items-center justify-center gap-2 px-3 py-8 text-xs text-gray-500"
      >
        <LoaderCircle :size="15" class="animate-spin" />{{ $t('ui.loadingFileTree') }}
      </div>
      <div
        v-else-if="error && !trees.has('.')"
        class="space-y-3 px-3 py-8 text-center text-xs text-red-600"
      >
        <p>{{ error }}</p>
        <button
          class="rounded-md border border-gray-200 px-3 py-1.5 text-gray-600 hover:bg-gray-50"
          type="button"
          @click="refresh"
        >
          {{ $t('ui.retry') }}
        </button>
      </div>
      <div
        v-else-if="trees.get('.')?.entries.length === 0"
        class="px-3 py-8 text-center text-xs text-gray-400"
      >
        {{ $t('ui.thisFolderIsEmpty') }}
      </div>
      <template v-else>
        <button
          v-for="item in visibleEntries"
          :key="item.entry.path"
          class="flex w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-gray-700 hover:bg-gray-100"
          type="button"
          :style="{ paddingLeft: `${item.depth * 16 + 8}px` }"
          :title="item.entry.path"
          @click="item.entry.type === 'directory' ? toggleDirectory(item.entry.path) : openFile(item.entry)"
        >
          <ChevronRight
            v-if="item.entry.type === 'directory'"
            :size="14"
            class="shrink-0 text-gray-400 transition-transform"
            :class="{ 'rotate-90': isExpanded(item.entry.path) }"
          />
          <span v-else class="w-3.5 shrink-0"></span>
          <FolderOpen
            v-if="item.entry.type === 'directory' && isExpanded(item.entry.path)"
            :size="16"
            class="shrink-0 text-amber-500"
          />
          <Folder
            v-else-if="item.entry.type === 'directory'"
            :size="16"
            class="shrink-0 text-amber-500"
          />
          <File v-else :size="16" class="shrink-0 text-gray-400" />
          <span class="min-w-0 truncate">{{ item.entry.name }}</span>
          <LoaderCircle
            v-if="item.entry.type === 'directory' && isLoading(item.entry.path)"
            :size="13"
            class="ml-auto shrink-0 animate-spin text-gray-400"
          />
        </button>
        <p v-if="trees.get('.')?.truncated" class="px-3 py-2 text-[11px] text-amber-600">
          {{ $t('ui.tooManyEntriesOnlySomeAre') }}
        </p>
        <p v-if="error" class="px-3 py-2 text-[11px] text-red-600">{{ error }}</p>
      </template>
    </div>
  </aside>
</template>
