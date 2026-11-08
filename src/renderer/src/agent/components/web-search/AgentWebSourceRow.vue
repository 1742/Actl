<script setup lang="ts">
import { ExternalLink } from '@lucide/vue';
import { computed } from 'vue';
import { openWebLink, webLinkHref, type AgentWebSource } from '../../utils/webSearch';

const props = defineProps<{ source: AgentWebSource; showSnippet?: boolean }>();
const href = computed(() => webLinkHref(props.source.url));
</script>

<template>
  <a
    :href="href"
    target="_blank"
    rel="noreferrer"
    class="agent-result-row group"
    @click.prevent="openWebLink(href)"
    @auxclick.middle.prevent="openWebLink(href)"
  >
    <span class="min-w-0 flex-1">
      <span class="block truncate text-gray-700">{{ source.title }}</span>
      <span class="block truncate text-[11px] text-gray-500">{{ source.hostname }}{{ source.path }}</span>
      <span v-if="showSnippet && source.snippet" class="mt-1 line-clamp-2 text-[11px] leading-4 text-gray-500">
        {{ source.snippet }}
      </span>
    </span>
    <ExternalLink :size="12" class="shrink-0 text-gray-400 group-hover:text-gray-600" />
  </a>
</template>
