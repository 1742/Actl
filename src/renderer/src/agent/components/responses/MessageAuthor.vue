<script setup lang="ts">
import { computed, inject } from 'vue';
import { tr } from '../../../i18n';
import { agentTreeKey } from '../../composables/useAgentTree';
import type { AIMessageItem } from './types';

const props = defineProps<{ item: AIMessageItem }>();
const team = inject(agentTreeKey);
const author = computed(() => {
  const { role, source } = props.item;
  if (source?.kind === 'agent') {
    const isChild = source.relationship === 'child';
    const name = tr(isChild ? 'agents.childAgent' : 'agents.parentAgent');
    const title = isChild
      ? team?.tree.value?.members.find(({ session }) => session.id === source.sessionId)?.session.title || source.sessionId
      : undefined;
    const purpose = source.purpose === 'message' ? undefined : tr(`agents.messagePurpose.${source.purpose}`);
    return [name, title, purpose, source.model].filter(Boolean).join(' · ');
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
