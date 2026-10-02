<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronDown, ExternalLink, Globe } from '@lucide/vue';
import type { AgentWebSource } from '../../utils/webSearch';

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
  <section
    v-if="sources.length"
    class="mt-3 w-full overflow-hidden rounded-xl border border-gray-200 bg-white text-sm"
  >
    <header class="flex min-w-0 items-center gap-3 px-3 py-2.5">
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600"
        ><Globe :size="16"
      /></span>
      <span class="min-w-0 flex-1">
        <span class="block font-medium text-gray-900">{{
          $t('dynamic.searchedSources', { count: sources.length })
        }}</span>
        <span v-if="queries" class="block truncate text-xs text-gray-500">{{ queries }}</span>
      </span>
    </header>
    <div class="border-t border-gray-100 px-3">
      <a
        v-for="source in visibleSources"
        :key="source.url"
        :href="source.url"
        target="_blank"
        rel="noreferrer"
        class="group flex min-w-0 items-center gap-2 border-b border-gray-100 py-2 last:border-b-0 hover:text-gray-800"
      >
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium text-gray-700">{{ source.title }}</span>
          <span class="block truncate text-[11px] text-gray-400"
            >{{ source.hostname }}{{ source.path }}</span
          >
        </span>
        <ExternalLink :size="12" class="shrink-0 text-gray-300 group-hover:text-gray-500" />
      </a>
      <button
        v-if="sources.length > 2"
        class="flex w-full items-center justify-start gap-1 py-2 text-xs text-gray-500 hover:text-gray-800"
        type="button"
        @click="expanded = !expanded"
      >
        <span>{{
          expanded ? $t('ui.hideSources') : $t('dynamic.moreSources', { count: sources.length - 2 })
        }}</span>
        <ChevronDown :size="14" class="transition-transform" :class="{ 'rotate-180': expanded }" />
      </button>
    </div>
  </section>
</template>
