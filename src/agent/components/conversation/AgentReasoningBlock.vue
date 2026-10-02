<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref } from 'vue';
import { ChevronRight } from '@lucide/vue';
import type { AIReasoningItem } from '../../types/aiResponse';
import { readContentText } from '../../utils/aiResponse';

const props = defineProps<{ item: AIReasoningItem; completed?: boolean }>();
const expanded = ref(false);
const summary = computed(() => readContentText(props.item.summary));
const text = computed(() => summary.value || readContentText(props.item.content));
const active = computed(() => !props.completed && props.item.status === 'in_progress');
const label = computed(() =>
  active.value ? summary.value || tr('ui.thinking') : tr('ui.thought'),
);
</script>

<template>
  <div v-if="text || active" class="min-w-0 text-sm text-gray-500">
    <button
      class="group flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left hover:text-gray-700"
      type="button"
      :disabled="!text"
      @click="expanded = !expanded"
    >
      <span
        class="min-w-0 truncate"
        :class="{ 'status-shimmer': active }"
        :title="active && summary ? summary : undefined"
        >{{ label }}</span
      >
      <ChevronRight
        v-if="text"
        :size="14"
        class="shrink-0 transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
    </button>
    <div
      v-if="expanded && text"
      class="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-gray-500"
    >
      {{ text }}
    </div>
  </div>
</template>
