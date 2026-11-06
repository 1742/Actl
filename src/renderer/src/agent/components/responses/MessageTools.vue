<script setup lang="ts">
import { computed, ref } from 'vue';
import { Copy, CopyCheck, RefreshCw } from '@lucide/vue';

import { copyToClipboard } from '../../../utils/clipboard';

const props = withDefaults(
  defineProps<{
    content?: string;
    showRegenerate?: boolean;
    timestamp?: string;
  }>(),
  {
    content: '',
    showRegenerate: false,
  },
);

const emit = defineEmits<{
  regenerate: [];
}>();

const isCopied = ref(false);
const messageTime = computed(() => {
  if (!props.timestamp) return undefined;
  const date = new Date(props.timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    datetime: date.toISOString(),
    label: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
    title: date.toLocaleString(),
  };
});

const handleCopy = async () => {
  if (!props.content) return;
  await copyToClipboard(props.content);
  isCopied.value = true;
  setTimeout(() => {
    isCopied.value = false;
  }, 2000);
};
</script>

<template>
  <div class="mt-1 flex items-center gap-2 text-gray-500 opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto">
    <button
      class="tool-btn"
      type="button"
      v-tooltip="{
        content: isCopied ? $t('ui.copied') : $t('ui.copy'),
        placement: 'bottom',
        distance: 8,
      }"
      @click.stop="handleCopy"
    >
      <Copy v-if="!isCopied" :size="14" />
      <CopyCheck v-else :size="14" />
    </button>

    <button
      v-if="showRegenerate"
      class="tool-btn"
      type="button"
      v-tooltip="{ content: $t('ui.regenerate'), placement: 'bottom', distance: 8 }"
      @click.stop="emit('regenerate')"
    >
      <RefreshCw :size="15" />
    </button>

    <slot />
    <time
      v-if="messageTime"
      :datetime="messageTime.datetime"
      :title="messageTime.title"
      class="whitespace-nowrap text-xs tabular-nums text-gray-400"
    >{{ messageTime.label }}</time>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.tool-btn {
  @apply flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800;
}

:deep(.tool-btn) {
  @apply flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800;
}
</style>
