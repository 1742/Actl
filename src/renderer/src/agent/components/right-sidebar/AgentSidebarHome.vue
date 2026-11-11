<script setup lang="ts">
import { ClipboardCheck, Folder, Terminal, Users } from '@lucide/vue';

defineProps<{ hasProject: boolean; projectLabel: string }>();
defineEmits<{ openFiles: []; openReview: []; openSubagents: [] }>();
</script>

<template>
  <section class="@container h-full overflow-y-auto px-4 py-6" :aria-label="$t('ui.sidebarFeatures')">
    <h2 class="mb-3 text-sm font-medium text-gray-800">{{ $t('ui.tools') }}</h2>
    <div class="grid grid-cols-1 gap-2 @min-[22rem]:grid-cols-2">
      <button
        class="tool"
        type="button"
        :disabled="!hasProject"
        :title="hasProject ? $t('dynamic.viewProjectFiles', { name: projectLabel }) : $t('ui.thisConversationHasNoProject')"
        @click="$emit('openFiles')"
      >
        <Folder :size="16" />
        {{ $t('ui.files') }}
      </button>
      <button class="tool" type="button" @click="$emit('openReview')">
        <ClipboardCheck :size="16" />
        {{ $t('ui.review') }}
      </button>
      <button class="tool" type="button" disabled :title="$t('ui.terminalIsComingSoon')">
        <Terminal :size="16" />
        {{ $t('ui.terminal') }}
      </button>
      <button class="tool" type="button" @click="$emit('openSubagents')">
        <Users :size="16" />
        {{ $t('agents.subagents') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";

.tool {
  @apply flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left text-sm text-gray-700 enabled:hover:bg-gray-100 disabled:text-gray-400;
}
</style>
