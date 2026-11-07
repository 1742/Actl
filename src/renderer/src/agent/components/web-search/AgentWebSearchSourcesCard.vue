<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, Globe } from '@lucide/vue';
import type { AgentWebSource } from '../../utils/webSearch.ts';
import AgentResultCard from '../conversation/AgentResultCard.vue';
import AgentWebSourceRow from './AgentWebSourceRow.vue';

const props = withDefaults(
  defineProps<{
    sources: AgentWebSource[];
    queries?: string;
  }>(),
  {
    queries: '',
  },
);
const expanded = ref(false);
const visibleSources = computed(() => (expanded.value ? props.sources : props.sources.slice(0, 2)));
</script>

<template>
  <AgentResultCard v-if="sources.length" class="mt-3">
    <template #icon><Globe :size="16" /></template>
    <template #title>{{ $t('dynamic.searchedSources', { count: sources.length }) }}</template>
    <template #detail>
      <span v-if="queries" class="block truncate text-xs text-gray-500">{{ queries }}</span>
    </template>
    <ul class="max-h-44 divide-y divide-gray-100 overflow-y-auto">
      <li v-for="source in visibleSources" :key="source.url">
        <AgentWebSourceRow :source="source" />
      </li>
    </ul>
    <button
      v-if="sources.length > 2"
      class="agent-result-row border-t border-gray-100 text-gray-500 hover:text-gray-800"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{
        expanded ? $t('ui.hideSources') : $t('dynamic.moreSources', { count: sources.length - 2 })
      }}</span>
      <ChevronDown :size="14" class="transition-transform" :class="{ 'rotate-180': expanded }" />
    </button>
  </AgentResultCard>
</template>
