<script setup lang="ts">
import { ref } from 'vue';
import { Copy, CopyCheck, RefreshCw } from '@lucide/vue';

import { copyToClipboard } from '../../../utils/clipboard';

const props = withDefaults(
  defineProps<{
    content?: string;
    showRegenerate?: boolean;
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
  <div class="mt-3 flex items-center gap-2 text-gray-500">
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
