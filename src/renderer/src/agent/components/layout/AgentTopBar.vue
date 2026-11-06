<script setup lang="ts">
import { computed } from 'vue';
import { Menu, PanelRight } from '@lucide/vue';

import { useAgentStore } from '../../stores/agent';
import { conversationName, projectName } from '../../utils';

const emit = defineEmits<{ toggleRightSidebar: []; openNavSidebar: [] }>();
const store = useAgentStore();

const sessionTitle = computed(() => conversationName(store.session?.title));
const project = computed(() =>
  store.session?.projectId
    ? store.projects.find((item) => item.id === store.session?.projectId)
    : store.draftProject,
);
const projectLabel = computed(() =>
  project.value ? projectName(project.value.cwd, project.value.name) : '',
);
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4"
  >
    <div class="flex min-w-0 items-center gap-2">
      <button
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 sm:hidden"
        type="button"
        :aria-label="$t('ui.openNavigation')"
        :title="$t('ui.openNavigation')"
        @click="emit('openNavSidebar')"
      >
        <Menu :size="18" />
      </button>
      <div class="min-w-0">
        <h1 class="truncate text-sm font-semibold text-gray-800">{{ sessionTitle }}</h1>
        <p v-if="projectLabel" class="truncate text-[11px] text-gray-400">{{ projectLabel }}</p>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <button
        class="flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
        type="button"
        :title="$t('ui.openSidebar')"
        :aria-label="$t('ui.openSidebar')"
        @click="emit('toggleRightSidebar')"
      >
        <PanelRight :size="19" />
      </button>
    </div>
  </header>
</template>
