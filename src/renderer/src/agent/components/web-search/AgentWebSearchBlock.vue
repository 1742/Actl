<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronRight, ExternalLink, Globe } from '@lucide/vue';
import type { AIWebSearchCallItem } from '../responses/types';
import { webSourcesFromOutput, webSourcesFromSearchCall } from '../../utils/webSearch.ts';
import AgentResultCard from '../conversation/AgentResultCard.vue';
import AgentWebSourceRow from './AgentWebSourceRow.vue';

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
  <AgentResultCard :expanded="expanded" @toggle="expanded = !expanded">
    <template #icon><Globe :size="16" /></template>
    <template #title>
      {{
        searching
          ? $t('ui.searchingTheWeb')
          : $t('dynamic.searchingWeb', { query: queryLabel || '' })
      }}
    </template>
    <template #detail>
      <span v-if="sources.length" class="block text-xs text-gray-500">
        {{ $t('dynamic.sourceCount', { count: sources.length }) }}
      </span>
    </template>
    <template #action>
      <ChevronRight
        :size="14"
        class="shrink-0 text-gray-400 transition-transform"
        :class="{ 'rotate-90': expanded }"
      />
    </template>
    <template v-if="expanded && (sources.length || (!searching && item?.action.url))" #default>
      <ul v-if="sources.length" class="max-h-44 divide-y divide-gray-100 overflow-y-auto">
        <li v-for="source in sources" :key="source.url">
          <AgentWebSourceRow :source="source" show-snippet />
        </li>
      </ul>
      <a
        v-else-if="!searching && item?.action.url"
        :href="item.action.url"
        target="_blank"
        rel="noreferrer"
        class="agent-result-row group"
      >
        <span class="min-w-0 flex-1 truncate text-gray-700">{{ item.action.url }}</span>
        <ExternalLink :size="12" class="shrink-0 text-gray-400 group-hover:text-gray-600" />
      </a>
    </template>
  </AgentResultCard>
</template>
