<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronRight, ExternalLink } from '@lucide/vue';
import type { WebSearchDetails } from '../../utils/toolCatalog/toolDetails';
import { openWebLink } from '../../utils/webSearch.ts';
import { toolDisplay } from '../../utils/toolCatalog/toolCatalog';
import AgentWebSourceRow from './AgentWebSourceRow.vue';

const props = defineProps<{ details: WebSearchDetails }>();
const expanded = ref(false);
const hasDetails = computed(() => Boolean(props.details.sources.length || props.details.url));
</script>

<template>
  <div class="min-w-0">
    <button
      type="button"
      class="flex h-6 max-w-full items-center gap-1.5 text-left text-[15px] text-gray-500 hover:text-gray-700"
      :disabled="!hasDetails"
      :aria-expanded="hasDetails ? expanded : undefined"
      @click="expanded = !expanded"
    >
      <component :is="toolDisplay('web_search').icon" :size="14" class="shrink-0" aria-hidden="true" />
      <span class="truncate" :title="details.query">{{ details.searching ? $t('ui.searchingTheWeb') : $t('dynamic.searchingWeb', { query: details.query }) }}</span>
      <span v-if="details.sources.length" class="shrink-0 text-sm">{{ $t('dynamic.sourceCount', { count: details.sources.length }) }}</span>
      <ChevronRight v-if="hasDetails" :size="14" class="shrink-0 transition-transform" :class="{ 'rotate-90': expanded }" />
    </button>
    <div v-if="expanded && hasDetails" class="mt-1 overflow-hidden rounded-md border border-gray-200">
      <ul v-if="details.sources.length" class="max-h-44 divide-y divide-gray-100 overflow-y-auto">
        <li v-for="source in details.sources" :key="source.url">
          <AgentWebSourceRow :source="source" show-snippet />
        </li>
      </ul>
      <a
        v-else-if="details.url"
        :href="details.href"
        target="_blank"
        rel="noreferrer"
        class="group flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50"
        @click.prevent="openWebLink(details.href)"
        @auxclick.middle.prevent="openWebLink(details.href)"
      >
        <span class="min-w-0 flex-1 truncate text-gray-700">{{ details.url }}</span>
        <ExternalLink :size="12" class="shrink-0 text-gray-400 group-hover:text-gray-600" />
      </a>
    </div>
  </div>
</template>
