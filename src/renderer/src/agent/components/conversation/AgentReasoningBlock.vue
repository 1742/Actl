<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref } from 'vue';
import { Brain, ChevronRight } from '@lucide/vue';
import type { AIReasoningItem } from '../responses/types';
import { readReasoningText } from '../../utils/aiResponse';

const props = defineProps<{ item: AIReasoningItem; completed?: boolean }>();
const expanded = ref(false);
const text = computed(() => readReasoningText(props.item));
const active = computed(() => !props.completed && props.item.status === 'in_progress');
const label = computed(() => active.value ? tr('ui.thinking') : tr('ui.thought'));
</script>

<template>
  <div v-if="text || active" class="min-w-0 text-[15px] text-gray-500">
    <button
      class="group flex h-6 min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left hover:text-gray-700"
      type="button"
      :disabled="!text"
      :aria-expanded="text ? expanded : undefined"
      @click="expanded = !expanded"
    >
      <Brain :size="14" class="shrink-0" aria-hidden="true" />
      <span class="shrink-0" :class="{ 'status-shimmer': active }">{{ label }}</span>
      <span v-if="text" class="min-w-0 truncate text-[13px] text-gray-500">{{ text }}</span>
      <ChevronRight
        v-if="text"
        :size="14"
        class="shrink-0 transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
    </button>
    <div
      v-if="expanded && text"
      class="mt-2 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white px-3 py-2 whitespace-pre-wrap wrap-anywhere text-[15px] leading-6 text-gray-500"
    >
      {{ text }}
    </div>
  </div>
</template>
