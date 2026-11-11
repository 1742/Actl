<script lang="ts">
import { reactive } from 'vue';
import type { AgentSession } from '../../../../../shared/agent/sessions';
type Tab =
  | { id: string; kind: 'home' | 'files' | 'review' | 'subagents' }
  | { id: string; kind: 'subagent'; session: AgentSession }
  | { id: string; kind: 'file'; name: string; path: string; workspaceId: string };
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
import { computed, inject, onActivated, onDeactivated, ref, watch } from 'vue';
import { ClipboardCheck, File, Folder, LayoutGrid, MessageSquare, Plus, Users, X } from '@lucide/vue';
import type { RuntimeWorkspaceDirectoryEntry } from '../../../../../shared/agent/workspace';
import { tr } from '../../../i18n';
import { useAgentStore } from '../../stores/agent';
import { projectName } from '../../utils';
import AgentSidebarHome from './AgentSidebarHome.vue';
import AgentWorkspacePanel from '../workspace/AgentWorkspacePanel.vue';
import AgentWorkspacePreview from '../workspace/AgentWorkspacePreview.vue';
import AgentSidebarReview from '../review/AgentSidebarReview.vue';
import AgentSidebarSubagents from '../sub-agents/AgentSidebarSubagents.vue';
import { reviewTargetKey } from '../review/reviewNavigation';

const emit = defineEmits<{ close: [] }>();
const store = useAgentStore();
const project = computed(() =>
  store.session
    ? store.projects.find((item) => item.id === store.session?.projectId)
    : store.draftProject,
);
const projectId = computed(() => project.value?.runtimeId ?? '');
const workspaces = computed(() => project.value?.workspaces ?? []);
const projectLabel = computed(() =>
  project.value ? projectName(project.value.cwd, project.value.name) : '',
);
const strip = ref<HTMLElement>();
const visible = ref(true);
const reviewTarget = inject(reviewTargetKey);

watch(projectId, (id) => {
  if (groups.has(id)) return;
  const tab = createHomeTab();
  groups.set(id, { tabs: [tab], activeId: tab.id });
}, { immediate: true, flush: 'sync' });

const group = computed(() => groups.get(projectId.value)!);
const rootId = computed(() => store.session?.rootSessionId ?? store.session?.runtimeId);
const visibleTabs = computed(() => group.value.tabs.filter(
  (tab) => tab.kind !== 'subagent' || tab.session.parentSessionId === rootId.value,
));
const activeTab = computed(() => visibleTabs.value.find((tab) => tab.id === group.value.activeId));
const hasFilesTab = computed(() => group.value.tabs.some((tab) => tab.kind === 'files'));

watch(workspaces, (items) => {
  const available = new Set(items.map(({ id }) => id));
  const state = group.value;
  state.tabs = state.tabs.filter((tab) => tab.kind !== 'file' || available.has(tab.workspaceId));
});

watch(visibleTabs, (tabs) => {
  if (activeTab.value) return;
  const fallback = tabs.find((tab) => tab.kind === 'subagents') ??
    tabs.find((tab) => tab.kind === 'files') ?? tabs[0];
  if (fallback) group.value.activeId = fallback.id;
  else if (visible.value) openTab(createHomeTab());
}, { immediate: true });

watch([projectId, activeTab, visible], () => {
  strip.value?.querySelector('[aria-current="page"]')?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
  });
}, { flush: 'post' });

onActivated(() => {
  visible.value = true;
  if (!visibleTabs.value.length) openTab(createHomeTab());
});
onDeactivated(() => { visible.value = false; });

function openTab(tab: Tab) {
  if (!group.value.tabs.some(({ id }) => id === tab.id)) group.value.tabs.push(tab);
  group.value.activeId = tab.id;
}

watch(() => reviewTarget?.value, (target) => {
  if (target) openTab({ id: 'review', kind: 'review' });
}, { immediate: true });

function openLatestReview() {
  if (reviewTarget) reviewTarget.value = undefined;
  openTab({ id: 'review', kind: 'review' });
}

function openFile(workspaceId: string, entry: RuntimeWorkspaceDirectoryEntry) {
  openTab({ id: `file:${workspaceId}:${entry.path.toLowerCase()}`, kind: 'file', name: entry.name, path: entry.path, workspaceId });
}

function openSubagent(session: AgentSession) {
  openTab({ id: `subagent:${session.id}`, kind: 'subagent', session });
}

function fileTitle(tab: Extract<Tab, { kind: 'file' }>) {
  const directory = workspaces.value.find(({ id }) => id === tab.workspaceId)?.path;
  return directory ? `${directory} · ${tab.path}` : tab.path;
}

const tabLabels = {
  home: 'ui.newSidebarTab',
  files: 'ui.files',
  review: 'ui.review',
  subagents: 'agents.subagents',
};

function tabLabel(tab: Tab) {
  if (tab.kind === 'file') return tab.name;
  if (tab.kind === 'subagent') return tab.session.title || tab.session.id;
  return tr(tabLabels[tab.kind]);
}

function closeTab(tab: Tab, index: number) {
  const state = group.value;
  state.tabs = state.tabs.filter(({ id }) => id !== tab.id);
  if (tab.kind === 'review' && reviewTarget) reviewTarget.value = undefined;
  const tabs = visibleTabs.value;
  if (!tabs.length) {
    visible.value = false;
    emit('close');
    return;
  }
  if (tab.id !== state.activeId) return;
  const list = tab.kind === 'subagent' ? tabs.find((item) => item.kind === 'subagents') : undefined;
  const next = list ?? tabs[index] ?? tabs[index - 1];
  if (next) state.activeId = next.id;
}
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <header class="flex h-14 shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-2">
      <nav ref="strip" class="inset-scrollbar tab-strip flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-0.5 py-px" :aria-label="$t('ui.sidebarFeatures')">
        <div
          v-for="(tab, index) in visibleTabs"
          :key="tab.id"
          class="flex h-10 max-w-52 shrink-0 items-center rounded-lg border pr-1 text-sm"
          :class="tab.id === group.activeId ? 'border-gray-200 bg-white text-gray-800 shadow-xs' : 'border-transparent text-gray-500 hover:bg-gray-100'"
        >
          <button
            class="flex h-full min-w-0 items-center gap-2 pl-3 pr-1.5"
            type="button"
            :aria-current="tab.id === group.activeId ? 'page' : undefined"
            :title="tab.kind === 'file' ? fileTitle(tab) : tab.kind === 'subagent' ? tabLabel(tab) : undefined"
            @click="group.activeId = tab.id"
          >
            <File v-if="tab.kind === 'file'" :size="16" class="shrink-0" />
            <Folder v-else-if="tab.kind === 'files'" :size="16" class="shrink-0" />
            <ClipboardCheck v-else-if="tab.kind === 'review'" :size="16" class="shrink-0" />
            <Users v-else-if="tab.kind === 'subagents'" :size="16" class="shrink-0" />
            <MessageSquare v-else-if="tab.kind === 'subagent'" :size="16" class="shrink-0" />
            <LayoutGrid v-else :size="16" class="shrink-0" />
            <span class="truncate">{{ tabLabel(tab) }}</span>
          </button>
          <button class="tab-icon size-6" type="button" :aria-label="$t('ui.closeSidebarTab')" :title="$t('ui.closeSidebarTab')" @click="closeTab(tab, index)">
            <X :size="14" />
          </button>
        </div>
      </nav>
      <button class="tab-icon size-9" type="button" :aria-label="$t('ui.newSidebarTab')" :title="$t('ui.newSidebarTab')" @click="openTab(createHomeTab())">
        <Plus :size="18" />
      </button>
      <button class="tab-icon size-9" type="button" :aria-label="$t('ui.closeSidebar')" :title="$t('ui.closeSidebar')" @click="emit('close')">
        <X :size="18" />
      </button>
    </header>

    <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
      <AgentSidebarHome
        v-if="activeTab?.kind === 'home'"
        :project-label="projectLabel"
        :has-project="Boolean(projectId)"
        @open-files="openTab({ id: 'files', kind: 'files' })"
        @open-review="openLatestReview"
        @open-subagents="openTab({ id: 'subagents', kind: 'subagents' })"
      />
      <KeepAlive>
        <AgentWorkspacePanel
          v-if="hasFilesTab"
          v-show="activeTab?.kind === 'files'"
          :key="projectId"
          :project-id="projectId"
          :workspaces="workspaces"
          :primary-workspace-id="project?.primaryWorkspaceId ?? ''"
          @open-file="openFile"
        />
      </KeepAlive>
      <AgentWorkspacePreview
        v-if="visible && activeTab?.kind === 'file'"
        :key="`${projectId}:${activeTab.id}`"
        :project-id="projectId"
        :workspace-id="activeTab.workspaceId"
        :path="activeTab.path"
      />
      <AgentSidebarReview v-if="visible && activeTab?.kind === 'review'" />
      <AgentSidebarSubagents
        v-if="activeTab?.kind === 'subagents' || activeTab?.kind === 'subagent'"
        :key="activeTab.id"
        :subagent="activeTab.kind === 'subagent' ? activeTab.session : undefined"
        :visible="visible"
        @open-subagent="openSubagent"
      />
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.tab-strip::-webkit-scrollbar-track:horizontal {
  margin-inline: 6px;
}

.tab-icon {
  @apply flex shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-800;
}
</style>
