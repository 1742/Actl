<script lang="ts">
import { reactive } from 'vue';
type Tab =
  | { id: string; kind: 'home' | 'files' }
  | { id: string; kind: 'file'; name: string; path: string };
interface TabGroup {
  tabs: Tab[];
  activeId: string;
}
const groups = reactive(new Map<string, TabGroup>());
let nextHomeId = 0;

function createHomeTab(): Tab {
  return { id: `home:${++nextHomeId}`, kind: 'home' };
}
</script>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { File, Folder, LayoutGrid, Plus, X } from '@lucide/vue';
import type { RuntimeWorkspaceDirectoryEntry } from '../../types';
import { useAgentStore } from '../../stores/agent';
import { projectName } from '../../utils';
import AgentSidebarHome from './AgentSidebarHome.vue';
import AgentWorkspacePanel from './AgentWorkspacePanel.vue';
import AgentWorkspacePreview from './AgentWorkspacePreview.vue';

defineEmits<{ close: [] }>();
const store = useAgentStore();
const project = computed(() =>
  store.session
    ? store.projects.find((item) => item.id === store.session?.projectId)
    : store.draftProject,
);
const projectId = computed(() => project.value?.runtimeId ?? '');
const projectLabel = computed(() =>
  project.value ? projectName(project.value.cwd, project.value.name) : '',
);
const strip = ref<HTMLElement>();
const visible = ref(true);

watch(projectId, (id) => {
  if (groups.has(id)) return;
  const tab = createHomeTab();
  groups.set(id, { tabs: [tab], activeId: tab.id });
}, { immediate: true, flush: 'sync' });

const group = computed(() => groups.get(projectId.value)!);
const activeTab = computed(() => group.value.tabs.find((tab) => tab.id === group.value.activeId));
const hasFilesTab = computed(() => group.value.tabs.some((tab) => tab.kind === 'files'));

watch([projectId, activeTab, visible], () => {
  strip.value?.querySelector('[aria-current="page"]')?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  });
}, { flush: 'post' });

onActivated(() => { visible.value = true; });
onDeactivated(() => { visible.value = false; });

function openTab(tab: Tab) {
  if (!group.value.tabs.some(({ id }) => id === tab.id)) group.value.tabs.push(tab);
  group.value.activeId = tab.id;
}

function openFile(entry: RuntimeWorkspaceDirectoryEntry) {
  openTab({ id: `file:${entry.path.toLowerCase()}`, kind: 'file', name: entry.name, path: entry.path });
}

function closeTab(index: number) {
  const state = group.value;
  const [closed] = state.tabs.splice(index, 1);
  if (!state.tabs.length) state.tabs.push(createHomeTab());
  if (closed?.id === state.activeId) state.activeId = (state.tabs[index] ?? state.tabs[index - 1])!.id;
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <header class="flex shrink-0 items-start gap-1 border-b border-gray-200 bg-white px-2 py-1.5">
      <nav ref="strip" class="tab-strip -my-0.5 flex min-w-0 flex-1 gap-1 overflow-x-auto p-0.5" :aria-label="$t('ui.sidebarFeatures')">
        <div
          v-for="(tab, index) in group.tabs"
          :key="tab.id"
          class="flex h-8 max-w-44 shrink-0 items-center rounded-lg border pr-1 text-xs"
          :class="tab.id === group.activeId ? 'border-gray-200 bg-white text-gray-800 shadow-xs' : 'border-transparent text-gray-500 hover:bg-gray-100'"
        >
          <button
            class="flex h-full min-w-0 items-center gap-1.5 pl-2 pr-1"
            type="button"
            :aria-current="tab.id === group.activeId ? 'page' : undefined"
            :title="tab.kind === 'file' ? tab.path : undefined"
            @click="group.activeId = tab.id"
          >
            <File v-if="tab.kind === 'file'" :size="14" class="shrink-0" />
            <Folder v-else-if="tab.kind === 'files'" :size="14" class="shrink-0" />
            <LayoutGrid v-else :size="14" class="shrink-0" />
            <span class="truncate">{{ tab.kind === 'file' ? tab.name : $t(tab.kind === 'files' ? 'ui.files' : 'ui.newSidebarTab') }}</span>
          </button>
          <button class="tab-icon h-5 w-5" type="button" :aria-label="$t('ui.closeSidebarTab')" :title="$t('ui.closeSidebarTab')" @click="closeTab(index)">
            <X :size="13" />
          </button>
        </div>
      </nav>
      <button class="tab-icon h-8 w-8" type="button" :aria-label="$t('ui.newSidebarTab')" :title="$t('ui.newSidebarTab')" @click="openTab(createHomeTab())">
        <Plus :size="16" />
      </button>
      <button class="tab-icon h-8 w-8" type="button" :aria-label="$t('ui.closeSidebar')" :title="$t('ui.closeSidebar')" @click="$emit('close')">
        <X :size="16" />
      </button>
    </header>

    <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
      <AgentSidebarHome
        v-if="activeTab?.kind === 'home'"
        :project-label="projectLabel"
        :has-project="Boolean(projectId)"
        @open-files="openTab({ id: 'files', kind: 'files' })"
      />
      <KeepAlive>
        <AgentWorkspacePanel
          v-if="hasFilesTab"
          v-show="activeTab?.kind === 'files'"
          :key="projectId"
          :project-id="projectId"
          :project-label="projectLabel"
          @open-file="openFile"
        />
      </KeepAlive>
      <AgentWorkspacePreview
        v-if="visible && activeTab?.kind === 'file'"
        :key="`${projectId}:${activeTab.id}`"
        :project-id="projectId"
        :path="activeTab.path"
      />
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.tab-strip::-webkit-scrollbar {
  height: 4px;
}

.tab-strip::-webkit-scrollbar-track:horizontal {
  margin-inline: 6px;
}

.tab-icon {
  @apply flex shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800;
}
</style>
