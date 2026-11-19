<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref, watch } from 'vue';
import { ChevronRight } from '@lucide/vue';
import type { ChildRunResult } from '../../../../../shared/agent/coordination';
import MessageOutput from '../responses/MessageOutput.vue';
import MessageTools from '../responses/MessageTools.vue';
import type { AIResponseContext } from '../responses/types';
import { buildAgentOutputBlocks, buildAgentOutputGroups, type AgentOutputGroup } from '../../utils';
import { normalizeResponse, readContentText } from '../../utils/aiResponse';
import { collectWebQueries, collectWebSources } from '../../utils/webSearch';
import { runtimeResourceKey } from '../../composables/useAgent';
import type { ReviewRun } from '../review/reviewNavigation';
import AgentActivityGroup from './AgentActivityGroup.vue';
import AgentReasoningBlock from './AgentReasoningBlock.vue';
import AgentWebSearchSourcesCard from '../web-search/AgentWebSearchSourcesCard.vue';
import AgentFileChangesCard from '../review/AgentFileChangesCard.vue';

const props = defineProps<{ context: AIResponseContext; sessionId: string; childResults?: ChildRunResult[] }>();
const groups = computed(() => buildAgentOutputGroups(props.context));
const completedHistoryExpanded = ref(false);
const isActive = computed(() =>
  ['in_progress', 'waiting_permission'].includes(props.context.response.status),
);
const finalMessageIndex = computed(() =>
  groups.value.findIndex((group) => group.type === 'message' && group.isFinal),
);
const finalText = computed(() => {
  const group = groups.value[finalMessageIndex.value];
  if (group?.type !== 'message') return '';
  return readContentText(group.item.content, 'output_text') || readContentText(group.item.content, 'input_text');
});
const reviewRuns = computed<ReviewRun[]>(() => {
  const runs = isActive.value ? [] : [{ sessionId: props.sessionId, runId: props.context.response.id }];
  for (const child of props.childResults ?? []) {
    if (child.hasFileChanges) runs.push({ sessionId: runtimeResourceKey('local', child.sessionId), runId: child.runId });
  }
  return runs;
});
const webSearch = computed(() => {
  const blocks = props.context.response.status === 'completed' && finalMessageIndex.value >= 0
    ? groups.value.flatMap((group) => group.type === 'activity' ? group.blocks : [])
    : [];
  for (const child of props.childResults ?? []) {
    const response = normalizeResponse({ id: child.runId, status: 'completed', output: child.searchOutput });
    blocks.push(...buildAgentOutputBlocks({ response }).filter((block) => block.type !== 'message'));
  }
  return { sources: collectWebSources(blocks), queries: collectWebQueries(blocks) };
});
const completedHistory = computed(() => {
  if (props.context.response.status !== 'completed' || finalMessageIndex.value <= 0) return [];
  return groups.value.slice(0, finalMessageIndex.value);
});
const displayedGroups = computed(() =>
  groups.value.slice(completedHistory.value.length),
);
const completedHistoryItemCount = computed(() =>
  completedHistory.value.reduce(
    (count, group) =>
      count +
      (group.type === 'activity'
        ? group.blocks.filter((block) => block.type !== 'reasoning' && block.type !== 'context_message').length
        : 0),
    0,
  ),
);
const completedHistoryStatus = computed(() =>
  completedHistoryItemCount.value
    ? tr('dynamic.executedCount', { count: completedHistoryItemCount.value })
    : completedHistory.value.some((group) => group.type === 'message' || group.blocks.some((block) => block.type === 'context_message'))
      ? tr('agents.runContext')
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
  <div class="group/message flex min-w-0 flex-col gap-3">
    <div v-if="completedHistory.length" class="min-w-0">
      <AgentReasoningBlock
        v-if="completedHistoryReasoning"
        :item="completedHistoryReasoning.item"
        completed
      />
      <template v-else>
        <button
          class="group flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left text-[15px] leading-5 text-gray-500 hover:text-gray-700"
          type="button"
          :aria-expanded="completedHistoryExpanded"
          @click="completedHistoryExpanded = !completedHistoryExpanded"
        >
          <span class="truncate">{{ completedHistoryStatus }}</span>
          <ChevronRight
            :size="14"
            class="shrink-0 transition-transform"
            :class="{ 'rotate-90': completedHistoryExpanded }"
          />
        </button>
        <div v-if="completedHistoryExpanded" class="mt-2 flex min-w-0 flex-col gap-3 border-t border-gray-200 pt-2">
          <template v-for="group in completedHistory" :key="group.key">
            <MessageOutput v-if="group.type === 'message'" :item="group.item" :show-tools="false" />
            <AgentActivityGroup v-else :blocks="group.blocks" :response-active="isActive" initially-expanded />
          </template>
        </div>
      </template>
    </div>
    <template v-for="group in displayedGroups" :key="group.key">
      <MessageOutput v-if="group.type === 'message'" :item="group.item" :show-tools="false" />
      <AgentActivityGroup v-else :blocks="group.blocks" :response-active="isActive" />
    </template>
    <AgentFileChangesCard v-if="reviewRuns.length" :runs="reviewRuns" />
    <AgentWebSearchSourcesCard :sources="webSearch.sources" :queries="webSearch.queries" />
    <MessageTools
      v-if="!isActive && finalText"
      :content="finalText"
      :timestamp="context.completedAt || context.updatedAt || context.createdAt"
    />
    <div v-if="!groups.length && isActive" class="flex items-center py-0.5 text-[15px] leading-5 text-gray-500">
      <span :class="{ 'status-shimmer': context.response.status === 'in_progress' }">{{
        context.response.status === 'waiting_permission'
          ? $t('ui.awaitingPermission')
          : $t('ui.processingStatus')
      }}</span>
    </div>
  </div>
</template>
