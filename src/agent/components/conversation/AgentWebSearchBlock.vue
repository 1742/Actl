<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronRight, ExternalLink } from '@lucide/vue';
import type { AIWebSearchCallItem } from '../../types/aiResponse';
import { webSourcesFromOutput, webSourcesFromSearchCall } from '../../utils/webSearch';

const props = defineProps<{
  item?: AIWebSearchCallItem;
  query?: string;
  output?: unknown;
  status?: string;
}>();
const expanded = ref(false);
const searching = computed(() =>
  ['in_progress', 'searching', 'preparing', 'running'].includes(
    props.item?.status ?? props.status ?? 'completed',
  ),
);
const queryLabel = computed(
  () =>
    props.query ||
    (props.item?.action.type === 'search' ? (props.item.action.queries?.join('、') ?? '') : ''),
);
const sources = computed(() =>
  props.item ? webSourcesFromSearchCall(props.item) : webSourcesFromOutput(props.output),
);
</script>

<template>
  <div class="min-w-0 text-gray-500">
    <button
      class="flex min-w-0 items-center gap-1.5 py-0.5 text-left text-sm hover:text-gray-700"
      type="button"
      @click="expanded = !expanded"
    >
      <span class="truncate">{{
        searching
          ? $t('ui.searchingTheWeb')
          : $t('dynamic.searchingWeb', { query: queryLabel || '' })
      }}</span>
      <span v-if="sources.length"
        >· {{ $t('dynamic.sourceCount', { count: sources.length }) }}</span
      >
      <ChevronRight
        :size="13"
        class="shrink-0 transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
    </button>
    <div v-if="expanded" class="mt-2 space-y-3 text-xs">
      <div v-if="sources.length" class="space-y-2.5">
        <a
          v-for="source in sources"
          :key="source.url"
          :href="source.url"
          target="_blank"
          rel="noreferrer"
          class="group block min-w-0 text-gray-400 hover:text-gray-600"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 flex-1 truncate">{{ source.title }}</span>
            <ExternalLink :size="12" class="shrink-0 text-gray-300 group-hover:text-gray-500" />
          </span>
          <span class="block min-w-0">
            <span class="block truncate text-[11px] text-gray-300"
              >{{ source.hostname }}{{ source.path }}</span
            >
            <span
              v-if="source.snippet"
              class="search-snippet mt-1 text-[11px] leading-4 text-gray-400"
              >{{ source.snippet }}</span
            >
          </span>
        </a>
      </div>
      <a
        v-else-if="!searching && item?.action.url"
        :href="item.action.url"
        target="_blank"
        rel="noreferrer"
        class="flex min-w-0 items-center gap-2 hover:text-gray-600"
        ><span class="truncate">{{ item.action.url }}</span
        ><ExternalLink :size="12" class="shrink-0"
      /></a>
    </div>
  </div>
</template>

<style scoped>
.search-snippet {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
</style>
