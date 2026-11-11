<script setup lang="ts">
import { computed } from 'vue';
import { tr } from '../../../i18n';
import type { AIMessageItem } from './types';

const props = defineProps<{ item: AIMessageItem }>();
const author = computed(() => {
  const { role, source } = props.item;
  if (role !== 'user') return '';
  if (source?.kind === 'model') {
    const name = tr('agents.parentAgent');
    return source.model ? [name, source.model].join(' · ') : name;
  }
  if (source?.kind === 'runtime') return tr('agents.runtime');
  return '';
});
</script>

<template>
  <div v-if="author" class="mb-1 max-w-full truncate text-xs text-gray-500" :title="author">{{ author }}</div>
</template>
