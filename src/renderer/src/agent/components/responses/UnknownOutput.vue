<script setup lang="ts">
import type { AIUnknownOutputItem } from '../../types/aiResponse';
defineProps<{ item: AIUnknownOutputItem }>();
</script>

<template>
  <details class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
    <summary class="cursor-pointer font-medium">
      {{ $t('ui.unsupportedOutputType') }}{{ item.type }}
    </summary>
    <pre class="mt-2 max-h-64 overflow-auto text-xs">{{ JSON.stringify(item.raw, null, 2) }}</pre>
  </details>
</template>
