<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { Cable, FolderOpen, Plus, RefreshCw, Search } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';

import { useNotifyStore } from '../../../composables/notify';
import { bridge } from '../../../services/bridge';
import { useRuntimeStore } from '../../../stores/runtime';
import { fetchLocalSkills } from '../../services/skills/service';
import { getAgentRuntimeClient } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimeMcpServer, RuntimeSkill } from '../../types';
import HomeSidebar from './HomeSidebar.vue';
import { mcpRefreshVersion, skillsRefreshVersion } from './libraryNavigation';

defineEmits<{ close: [] }>();
const route = useRoute();
const router = useRouter();
const notify = useNotifyStore();
const agent = useAgentStore();
const runtime = useRuntimeStore();

const section = computed(() => {
  if (route.name === 'aiSkills' || route.name === 'aiSkillDetail') return 'skills';
  if (route.name === 'aiMcp') return 'mcp';
  if (route.name === 'aiAgentSettings') return 'settings';
  return 'home';
});
const skills = ref<RuntimeSkill[]>([]);
const servers = ref<RuntimeMcpServer[]>([]);
const loading = ref(false);
const error = ref('');
const search = ref('');
const filteredSkills = computed(() =>
  skills.value.filter((skill) =>
    `${skill.name} ${skill.description}`
      .toLocaleLowerCase()
      .includes(search.value.toLocaleLowerCase()),
  ),
);
const settingsSections = computed(
  () =>
    [
      { id: 'agent', label: tr('ui.localAgent') },
      { id: 'appearance', label: tr('ui.appearance') },
      { id: 'prompts', label: tr('ui.prompts') },
      { id: 'search', label: tr('ui.webSearch') },
      { id: 'models', label: tr('ui.modelsAndProviders') },
    ] as const,
);

async function load() {
  if (section.value !== 'skills' && section.value !== 'mcp') return;
  if (agent.runtimeAvailability.local !== 'available') return;
  loading.value = true;
  error.value = '';
  try {
    if (section.value === 'skills') skills.value = (await fetchLocalSkills(runtime.agentUrl)).data;
    else servers.value = await getAgentRuntimeClient('local').listMcpServers();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('ui.failedToLoadList');
  } finally {
    loading.value = false;
  }
}

function refresh() {
  if (section.value === 'skills') skillsRefreshVersion.value++;
  else mcpRefreshVersion.value++;
  void load();
}

async function openDirectory() {
  try {
    await bridge.openSkillsDirectory();
  } catch (cause) {
    notify.error(cause instanceof Error ? cause.message : tr('ui.couldNotOpenFolder'));
  }
}

watch([section, () => agent.runtimeAvailability.local], () => {
  void load();
});
watch([skillsRefreshVersion, mcpRefreshVersion], () => {
  void load();
});
onMounted(() => {
  void load();
});
</script>

<template>
  <div class="secondary-sidebar">
    <HomeSidebar v-if="section === 'home'" class="min-h-0 flex-1" @close="$emit('close')" />

    <template v-else>
      <header class="secondary-header">
        <h1>
          {{
            section === 'skills' ? 'Skills' : section === 'mcp' ? 'MCP Servers' : $t('ui.settings')
          }}
        </h1>
        <div v-if="section !== 'settings'" class="secondary-actions">
          <button
            v-if="section === 'skills'"
            type="button"
            :title="$t('ui.openSkillsFolder')"
            :aria-label="$t('ui.openSkillsFolder')"
            @click="openDirectory"
          >
            <FolderOpen :size="16" />
          </button>
          <button
            type="button"
            :title="$t('ui.refreshList')"
            :aria-label="$t('ui.refreshList')"
            :disabled="loading"
            @click="refresh"
          >
            <RefreshCw :size="16" :class="{ 'animate-spin': loading }" />
          </button>
        </div>
      </header>

      <template v-if="section === 'skills'">
        <label class="sidebar-search">
          <Search :size="15" />
          <input
            v-model="search"
            type="search"
            :placeholder="$t('ui.searchSkills')"
            :aria-label="$t('ui.searchSkills')"
          />
        </label>
        <div class="secondary-scroll">
          <p class="sidebar-heading">
            {{ $t('ui.installedSkills') }} <span>{{ filteredSkills.length }}</span>
          </p>
          <p v-if="error" class="sidebar-empty text-red-600">{{ error }}</p>
          <p v-else-if="loading && !skills.length" class="sidebar-empty">{{ $t('ui.loading') }}</p>
          <button
            v-for="skill in filteredSkills"
            :key="skill.id"
            type="button"
            class="secondary-row"
            :class="{
              'secondary-row-selected':
                route.name === 'aiSkillDetail' && route.params.skillId === skill.id,
            }"
            :title="skill.description"
            @click="router.push({ name: 'aiSkillDetail', params: { skillId: skill.id } })"
          >
            <span class="truncate">{{ skill.name }}</span>
          </button>
          <p v-if="!loading && !error && !filteredSkills.length" class="sidebar-empty">
            {{ search ? $t('ui.noMatchingSkills') : $t('ui.noInstalledSkills') }}
          </p>
        </div>
      </template>

      <template v-else-if="section === 'mcp'">
        <div class="secondary-scroll">
          <button
            type="button"
            class="secondary-row secondary-add"
            :class="{ 'secondary-row-selected': route.query.create === '1' }"
            :disabled="agent.runtimeAvailability.local !== 'available' || agent.hasActiveResponse"
            @click="router.push({ name: 'aiMcp', query: { create: '1' } })"
          >
            <Plus :size="16" />{{ $t('ui.addServer') }}
          </button>
          <p class="sidebar-heading">
            {{ $t('ui.configuredServers') }} <span>{{ servers.length }}</span>
          </p>
          <p v-if="error" class="sidebar-empty text-red-600">{{ error }}</p>
          <p v-else-if="loading && !servers.length" class="sidebar-empty">{{ $t('ui.loading') }}</p>
          <button
            v-for="server in servers"
            :key="server.name"
            type="button"
            class="secondary-row"
            :class="{
              'secondary-row-selected':
                route.query.server === server.name ||
                (!route.query.server && !route.query.create && servers[0]?.name === server.name),
            }"
            @click="router.push({ name: 'aiMcp', query: { server: server.name } })"
          >
            <Cable :size="15" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ server.name }}</span>
            <span
              class="server-status"
              :class="server.connected ? 'connected' : ''"
              :title="
                server.connected
                  ? $t('ui.connected')
                  : server.config.enabled
                    ? $t('ui.disconnected')
                    : $t('ui.disabled')
              "
            ></span>
          </button>
          <p v-if="!loading && !error && !servers.length" class="sidebar-empty">
            {{ $t('ui.noMcpServers') }}
          </p>
        </div>
      </template>

      <nav v-else class="secondary-scroll" :aria-label="$t('ui.settingsCategories')">
        <button
          v-for="item in settingsSections"
          :key="item.id"
          type="button"
          class="secondary-row"
          :class="{ 'secondary-row-selected': (route.query.section || 'agent') === item.id }"
          @click="router.push({ name: 'aiAgentSettings', query: { section: item.id } })"
        >
          {{ item.label }}
        </button>
      </nav>
    </template>
  </div>
</template>

<style scoped>
.secondary-sidebar {
  display: flex;
  height: 100%;
  width: 100%;
  min-height: 0;
  flex-direction: column;
  color: var(--color-sidebar-fg);
  background: var(--color-sidebar-bg);
}
.secondary-header {
  display: flex;
  min-height: 54px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px 0 16px;
}
.secondary-header h1 {
  overflow: hidden;
  font-size: 15px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.secondary-actions {
  display: flex;
  gap: 2px;
}
.secondary-actions button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: var(--color-sidebar-muted);
}
.secondary-actions button:hover,
.secondary-actions button:focus-visible {
  background: var(--color-sidebar-hover);
  color: var(--color-sidebar-fg);
}
.sidebar-search {
  display: flex;
  height: 34px;
  flex: 0 0 34px;
  align-items: center;
  gap: 7px;
  margin: 0 12px 12px;
  padding: 0 9px;
  border: 1px solid var(--color-shell-border);
  border-radius: 9px;
  color: var(--color-sidebar-muted);
  background: var(--color-white);
}
.sidebar-search input {
  min-width: 0;
  width: 100%;
  outline: none;
  background: transparent;
  font-size: 12px;
}
.secondary-scroll {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 4px 9px 16px;
}
.sidebar-heading {
  display: flex;
  justify-content: space-between;
  padding: 10px 9px 6px;
  color: var(--color-sidebar-muted);
  font-size: 12px;
}
.sidebar-empty {
  padding: 7px 9px;
  color: var(--color-sidebar-muted);
  font-size: 12px;
  line-height: 1.5;
}
.secondary-row {
  display: flex;
  min-height: 37px;
  width: 100%;
  align-items: center;
  gap: 9px;
  margin: 1px 0;
  padding: 7px 10px;
  border-radius: 8px;
  text-align: left;
  font-size: 14px;
}
.secondary-row:hover {
  background: var(--color-sidebar-hover);
}
.secondary-row:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.secondary-row-selected {
  background: var(--color-sidebar-selected);
  color: var(--color-sidebar-fg);
}
.secondary-add {
  margin: 0 0 10px;
}
.server-status {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: #babec3;
}
.server-status.connected {
  background: #24a46b;
}
</style>
