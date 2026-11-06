<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref, watch } from 'vue';
import {
  ChevronLeft,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from '@lucide/vue';
import { useRouter } from 'vue-router';

import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimeWorkspaceDirectoryEntry, RuntimeWorkspaceTree } from '../../types';
import { projectName } from '../../utils';

const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const store = useAgentStore();
const trees = ref(new Map<string, RuntimeWorkspaceTree>());
const expanded = ref(new Set<string>());
const loading = ref(new Set<string>());
const error = ref('');
const requestVersion = ref(0);

const project = computed(() =>
  store.session?.projectId
    ? store.projects.find((item) => item.id === store.session?.projectId)
    : store.draftProject,
);
const projectId = computed(() => project.value?.runtimeId || '');
const projectLabel = computed(() =>
  project.value ? projectName(project.value.cwd, project.value.name) : '',
);

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
  if (!projectId.value || (trees.value.has(path) && !force) || loading.value.has(path)) return;
  const version = requestVersion.value;
  loading.value = new Set(loading.value).add(path);
  error.value = '';
  try {
    const { client } = getAgentRuntimeContext(store.runtimeKind);
    const tree = await client.listWorkspaceDirectory(projectId.value, path);
    if (version !== requestVersion.value || projectId.value !== project.value?.runtimeId) return;
    const next = new Map(trees.value);
    next.set(path, tree);
    trees.value = next;
  } catch (cause) {
    if (version === requestVersion.value)
      error.value = cause instanceof Error ? cause.message : tr('ui.failedToLoadFileTree');
  } finally {
    const next = new Set(loading.value);
    next.delete(path);
    loading.value = next;
  }
}

async function toggleDirectory(path: string) {
  if (isExpanded(path)) {
    const next = new Set(expanded.value);
    next.delete(path);
    expanded.value = next;
    return;
  }
  await loadDirectory(path);
  const next = new Set(expanded.value);
  next.add(path);
  expanded.value = next;
}

async function refresh() {
  if (!projectId.value) return;
  trees.value = new Map();
  expanded.value = new Set();
  error.value = '';
  requestVersion.value += 1;
  await loadDirectory('.', true);
}

async function returnToSidebarHome() {
  await router.push({ name: 'aiAgentRightSidebarHome' });
}

watch(
  projectId,
  (current, previous) => {
    if (current === previous) return;
    requestVersion.value += 1;
    trees.value = new Map();
    expanded.value = new Set();
    loading.value = new Set();
    error.value = '';
    if (current) void loadDirectory('.');
  },
  { immediate: true },
);
</script>

<template>
  <aside class="flex h-full min-h-0 w-full flex-col bg-white" :aria-label="$t('ui.workspaceFiles')">
    <div class="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 px-3">
      <div class="flex min-w-0 items-center gap-1">
        <button
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          type="button"
          :aria-label="$t('ui.backToSidebarHome')"
          :title="$t('ui.back')"
          @click="returnToSidebarHome"
        >
          <ChevronLeft :size="18" />
        </button>
        <div class="min-w-0">
          <h2 class="truncate text-sm font-semibold text-gray-800">{{ $t('ui.files') }}</h2>
          <p class="truncate text-[11px] text-gray-400" :title="projectLabel">
            {{ projectLabel || $t('ui.noProjectSelected') }}
          </p>
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          type="button"
          :aria-label="$t('ui.refreshFileTree')"
          :title="$t('ui.refresh')"
          @click="refresh"
        >
          <RefreshCw :size="15" />
        </button>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          type="button"
          :aria-label="$t('ui.closeFiles')"
          :title="$t('ui.off')"
          @click="emit('close')"
        >
          <X :size="17" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
      <div v-if="!projectId" class="px-3 py-8 text-center text-xs text-gray-400">
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
          @click="item.entry.type === 'directory' ? toggleDirectory(item.entry.path) : undefined"
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
