<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref, watch } from 'vue';
import { ChevronRight } from '@lucide/vue';
import MessageOutput from '../responses/MessageOutput.vue';
import MessageTools from '../responses/MessageTools.vue';
import type { AIResponseContext } from '../../types/aiResponse';
import { buildAgentOutputGroups, type AgentOutputGroup } from '../../utils';
import { collectWebQueries, collectWebSources } from '../../utils/webSearch';
import AgentActivityGroup from './AgentActivityGroup.vue';
import AgentReasoningBlock from './AgentReasoningBlock.vue';
import AgentWebSearchSourcesCard from './AgentWebSearchSourcesCard.vue';

const props = defineProps<{ context: AIResponseContext }>();
const groups = computed(() => buildAgentOutputGroups(props.context));
const completedHistoryExpanded = ref(false);
const isActive = computed(() =>
  ['in_progress', 'waiting_permission'].includes(props.context.response.status),
);
const finalMessageIndex = computed(() =>
  groups.value.map((group) => group.type).lastIndexOf('message'),
);
const finalWebSearch = computed(() => {
  if (props.context.response.status !== 'completed' || finalMessageIndex.value < 0)
    return { sources: [], queries: '' };
  const blocks = groups.value.flatMap((group) => (group.type === 'activity' ? group.blocks : []));
  return { sources: collectWebSources(blocks), queries: collectWebQueries(blocks) };
});
const completedHistory = computed(() =>
  props.context.response.status === 'completed' && finalMessageIndex.value > 0
    ? groups.value.slice(0, finalMessageIndex.value)
    : [],
);
const displayedGroups = computed(() =>
  completedHistory.value.length ? groups.value.slice(finalMessageIndex.value) : groups.value,
);
const completedHistoryItemCount = computed(() =>
  completedHistory.value.reduce(
    (count, group) =>
      count +
      (group.type === 'activity'
        ? group.blocks.filter((block) => block.type !== 'reasoning').length
        : 1),
    0,
  ),
);
const completedHistoryStatus = computed(() =>
  completedHistoryItemCount.value
    ? tr('dynamic.executedCount', { count: completedHistoryItemCount.value })
    : tr('ui.thought'),
);
function singleReasoningBlock(history: AgentOutputGroup[]) {
  const group = history[0];
  if (history.length !== 1 || group?.type !== 'activity' || group.blocks.length !== 1)
    return undefined;
  const block = group.blocks[0];
  return block?.type === 'reasoning' ? block : undefined;
}
const completedHistoryReasoning = computed(() => singleReasoningBlock(completedHistory.value));
watch(isActive, (active, wasActive) => {
  if (!active && wasActive) completedHistoryExpanded.value = false;
});
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <div v-if="completedHistory.length" class="min-w-0">
      <AgentReasoningBlock
        v-if="completedHistoryReasoning"
        :item="completedHistoryReasoning.item"
        completed
      />
      <template v-else>
        <button
          class="group flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left text-sm text-gray-500 hover:text-gray-700"
          type="button"
          @click="completedHistoryExpanded = !completedHistoryExpanded"
        >
          <span class="truncate">{{ completedHistoryStatus }}</span>
          <ChevronRight
            :size="14"
            class="shrink-0 transition-transform"
            :class="{ 'rotate-90': completedHistoryExpanded }"
          />
        </button>
        <div v-if="completedHistoryExpanded" class="mt-2 border-b border-gray-200"></div>
        <div v-if="completedHistoryExpanded" class="mt-2 flex min-w-0 flex-col gap-4">
          <template v-for="group in completedHistory" :key="group.key">
            <MessageOutput v-if="group.type === 'message'" :item="group.item" :show-tools="false" />
            <AgentActivityGroup v-else :blocks="group.blocks" :response-active="isActive" />
          </template>
        </div>
      </template>
    </div>
    <template v-for="group in displayedGroups" :key="group.key">
      <MessageOutput v-if="group.type === 'message'" :item="group.item" :show-tools="false">
        <template v-if="group.isFinal" #footer="{ content }">
          <AgentWebSearchSourcesCard
            :sources="finalWebSearch.sources"
            :queries="finalWebSearch.queries"
          />
          <MessageTools v-if="!isActive" :content="content" />
        </template>
      </MessageOutput>
      <AgentActivityGroup v-else :blocks="group.blocks" :response-active="isActive" />
    </template>
    <div v-if="!groups.length && isActive" class="flex items-center py-0.5 text-sm text-gray-500">
      <span :class="{ 'status-shimmer': context.response.status === 'in_progress' }">{{
        context.response.status === 'waiting_permission'
          ? $t('ui.awaitingPermission')
          : $t('ui.processingStatus')
      }}</span>
    </div>
  </div>
</template>
