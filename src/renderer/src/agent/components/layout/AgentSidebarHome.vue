<script setup lang="ts">
import { computed } from 'vue';
import { ClipboardCheck, Folder, Globe2, Terminal, X } from '@lucide/vue';
import { useRouter } from 'vue-router';

import { useAgentStore } from '../../stores/agent';
import { projectName } from '../../utils';

const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const store = useAgentStore();
const project = computed(() =>
  store.session?.projectId
    ? store.projects.find((item) => item.id === store.session?.projectId)
    : store.draftProject,
);
const projectLabel = computed(() =>
  project.value ? projectName(project.value.cwd, project.value.name) : '',
);

async function openFiles() {
  if (!project.value) return;
  await router.push({ name: 'aiAgentRightSidebarFiles' });
}
</script>

<template>
  <aside class="sidebar-home" :aria-label="$t('ui.sidebarFeatures')">
    <button
      class="sidebar-close"
      type="button"
      :aria-label="$t('ui.closeSidebar')"
      :title="$t('ui.off')"
      @click="emit('close')"
    >
      <X :size="16" />
    </button>

    <nav class="sidebar-menu" :aria-label="$t('ui.tools')">
      <button class="sidebar-item" type="button" disabled :title="$t('ui.reviewIsComingSoon')">
        <ClipboardCheck :size="16" stroke-width="1.5" />
        <span>{{ $t('ui.review') }}</span>
      </button>

      <button class="sidebar-item" type="button" disabled :title="$t('ui.terminalIsComingSoon')">
        <Terminal :size="16" stroke-width="1.5" />
        <span>{{ $t('ui.terminal') }}</span>
      </button>

      <button class="sidebar-item" type="button" disabled :title="$t('ui.browserIsComingSoon')">
        <Globe2 :size="16" stroke-width="1.5" />
        <span>{{ $t('ui.browser') }}</span>
      </button>

      <button
        class="sidebar-item"
        type="button"
        :disabled="!project"
        :title="
          project
            ? $t('dynamic.viewProjectFiles', { name: projectLabel })
            : $t('ui.thisConversationHasNoProject')
        "
        @click="openFiles"
      >
        <Folder :size="16" stroke-width="1.5" />
        <span>{{ $t('ui.files') }}</span>
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.sidebar-home {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  align-items: center;
  justify-content: center;
  background: var(--color-white);
  color: var(--color-sidebar-fg);
}

.sidebar-close {
  position: absolute;
  top: 0.625rem;
  right: 0.625rem;
  display: flex;
  width: 1.75rem;
  height: 1.75rem;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 0.5rem;
  color: var(--color-sidebar-muted);
  background: transparent;
  cursor: pointer;
}

.sidebar-close:hover {
  color: var(--color-sidebar-fg);
  background: var(--color-sidebar-hover);
}

.sidebar-menu {
  display: flex;
  width: min(100% - 2rem, 31rem);
  flex-direction: column;
  gap: 0.375rem;
}

.sidebar-item {
  display: flex;
  width: 100%;
  height: 2.375rem;
  align-items: center;
  gap: 0.625rem;
  padding: 0 0.125rem;
  border: 0;
  border-radius: 0.375rem;
  color: var(--color-sidebar-fg);
  background: transparent;
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}

.sidebar-item:hover:not(:disabled) {
  background: var(--color-sidebar-hover);
}

.sidebar-item:disabled {
  color: var(--color-sidebar-fg);
  cursor: default;
  opacity: 1;
}

.sidebar-item svg {
  flex: 0 0 auto;
  color: var(--color-sidebar-muted);
}

.sidebar-item span {
  flex: 1;
}
</style>
