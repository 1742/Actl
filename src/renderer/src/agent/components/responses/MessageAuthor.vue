<script setup lang="ts">
import { computed, inject } from 'vue';
import { tr } from '../../../i18n';
import { agentTreeKey } from '../../composables/useAgentTree';
import { runtimeResourceKey } from '../../composables/useAgent';
import type { AIMessageItem } from './types';

const props = defineProps<{ item: AIMessageItem }>();
const team = inject(agentTreeKey);
const author = computed(() => {
  const { role, source } = props.item;
  if (source?.kind === 'agent') {
    const name = tr(source.relationship === 'parent' ? 'agents.parentAgent'
      : source.relationship === 'child' ? 'agents.childAgent' : 'agents.peerAgent');
    const title = team?.tree.value?.members[runtimeResourceKey('local', source.sessionId)]?.session.title;
    return [name, title].filter(Boolean).join(' · ');
  }
  if (source?.kind === 'model' && role === 'user')
    return [tr('agents.parentAgent'), source.model].filter(Boolean).join(' · ');
  if (source?.kind === 'runtime') return tr('agents.runtime');
  return '';
});
const authorDetails = computed(() => {
  const source = props.item.source;
  return source?.kind === 'agent' ? `${author.value}\n${source.sessionId}` : author.value;
});
</script>

<template>
  <div v-if="author" class="mb-1 max-w-full truncate text-xs text-gray-500" :title="authorDetails">{{ author }}</div>
</template>
