<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed } from 'vue';
import { Cable, House, Package, Settings2 } from '@lucide/vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const active = computed(() => {
  if (route.name === 'aiSkills' || route.name === 'aiSkillDetail') return 'skills';
  if (route.name === 'aiMcp') return 'mcp';
  if (route.name === 'aiAgentSettings') return 'settings';
  return 'home';
});

const items = computed(
  () =>
    [
      { id: 'home', label: tr('ui.home'), icon: House, route: 'aiAgent' },
      { id: 'skills', label: 'Skills', icon: Package, route: 'aiSkills' },
      { id: 'mcp', label: 'MCP', icon: Cable, route: 'aiMcp' },
    ] as const,
);
</script>

<template>
  <nav class="activity-bar" :aria-label="$t('ui.mainNavigation')">
    <div class="activity-bar-group">
      <button
        v-for="item in items"
        :key="item.id"
        class="activity-button"
        :class="{ 'activity-button-active': active === item.id }"
        type="button"
        :title="item.label"
        :aria-label="item.label"
        :aria-current="active === item.id ? 'page' : undefined"
        @click="router.push({ name: item.route })"
      >
        <component :is="item.icon" :size="19" :stroke-width="1.8" />
      </button>
    </div>
    <button
      class="activity-button"
      :class="{ 'activity-button-active': active === 'settings' }"
      type="button"
      :title="$t('ui.settings')"
      :aria-label="$t('ui.settings')"
      :aria-current="active === 'settings' ? 'page' : undefined"
      @click="router.push({ name: 'aiAgentSettings' })"
    >
      <Settings2 :size="19" :stroke-width="1.8" />
    </button>
  </nav>
</template>

<style scoped>
.activity-bar {
  display: flex;
  width: 52px;
  flex: 0 0 52px;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 10px 5px;
  color: var(--color-sidebar-muted);
}
.activity-bar-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.activity-button {
  display: flex;
  width: 38px;
  height: 38px;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}
.activity-button:hover {
  background: var(--color-sidebar-hover);
  color: var(--color-sidebar-fg);
}
.activity-button-active {
  background: var(--color-sidebar-selected);
  color: var(--color-sidebar-fg);
}
.activity-button-active:hover {
  background: var(--color-sidebar-selected);
  color: var(--color-sidebar-fg);
}
.activity-button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
</style>
