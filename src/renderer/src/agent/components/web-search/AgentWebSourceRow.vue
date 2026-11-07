<script setup lang="ts">
import { ExternalLink } from '@lucide/vue';
import type { AgentWebSource } from '../../utils/webSearch';

defineProps<{ source: AgentWebSource; showSnippet?: boolean }>();
</script>

<template>
  <a
    :href="source.url"
    target="_blank"
    rel="noreferrer"
    class="agent-result-row group"
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
