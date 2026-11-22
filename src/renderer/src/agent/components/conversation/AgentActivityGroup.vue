<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref } from 'vue';
import { ChevronRight } from '@lucide/vue';
import MessageOutput from '../responses/MessageOutput.vue';
import AgentMailMessage from '../responses/AgentMailMessage.vue';
import { isAgentMailMessage, readReasoningText } from '../../utils/aiResponse';
import UnknownOutput from '../responses/UnknownOutput.vue';
import type { AgentOutputBlock } from './types';
import { agentOutputHint } from '../../utils';
import AgentReasoningBlock from './AgentReasoningBlock.vue';
import AgentToolBlock from './AgentToolBlock.vue';

const props = defineProps<{
  blocks: Exclude<AgentOutputBlock, { type: 'message' }>[];
  responseActive?: boolean;
  initiallyExpanded?: boolean;
}>();
const expanded = ref(Boolean(props.initiallyExpanded));
const itemCount = computed(() => props.blocks.filter((block) => block.type !== 'reasoning' && block.type !== 'context_message').length);
const lastBlock = computed(() => props.blocks.at(-1));
const lastItemHint = computed(() => {
  return lastBlock.value ? agentOutputHint(lastBlock.value) : '';
});
const groupStatus = computed(() => {
  if (props.responseActive === false) return 'completed' as const;
  if (
    props.blocks.some(
      (block) =>
        (block.type === 'tool' && block.status === 'waiting_permission') ||
        (block.type === 'permission' && block.item.status === 'pending'),
    )
  )
    return 'waiting_permission' as const;
  if (
    props.blocks.some(
      (block) =>
        (block.type === 'tool' && (block.status === 'preparing' || block.status === 'running')) ||
        (block.type === 'web_search' &&
          ['in_progress', 'searching'].includes(block.item.status ?? 'completed')) ||
        (block.type === 'reasoning' && block.item.status === 'in_progress'),
    )
  )
    return 'in_progress' as const;
  return 'completed' as const;
});
const visibleHint = computed(() => (groupStatus.value === 'completed' ? '' : lastItemHint.value));
const reasoningPreview = computed(() => {
  const block = lastBlock.value;
  return groupStatus.value === 'in_progress' && block?.type === 'reasoning' && block.item.status === 'in_progress'
    ? readReasoningText(block.item)
    : '';
});
const statusLabel = computed(() => {
  if (groupStatus.value === 'waiting_permission') return tr('ui.awaitingPermission');
  if (groupStatus.value === 'in_progress')
    return itemCount.value
      ? tr('dynamic.executingCount', { count: itemCount.value })
      : tr('ui.running');
  return itemCount.value
    ? tr('dynamic.executedCount', { count: itemCount.value })
    : props.blocks.some((block) => block.type === 'context_message') ? tr('agents.runContext') : tr('ui.thought');
});
const singleReasoningBlock = computed(() =>
  props.blocks.length === 1 && props.blocks[0]?.type === 'reasoning' ? props.blocks[0] : undefined,
);
</script>

<template>
  <div class="min-w-0">
    <AgentReasoningBlock
      v-if="singleReasoningBlock"
      :item="singleReasoningBlock.item"
      :completed="groupStatus === 'completed'"
    />
    <template v-else>
      <button
        class="group flex min-w-0 max-w-full items-center gap-1.5 py-0.5 text-left text-[15px] leading-5 text-gray-500 hover:text-gray-700"
        type="button"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span
          v-if="visibleHint"
          class="min-w-0 truncate"
          :class="{ 'shrink-0': reasoningPreview, 'status-shimmer': groupStatus === 'in_progress' }"
          :title="visibleHint"
          >{{ visibleHint }}</span
        >
        <span v-else class="truncate">{{ statusLabel }}</span>
        <span v-if="reasoningPreview" class="min-w-0 truncate text-[13px] text-gray-500">{{ reasoningPreview }}</span>
        <ChevronRight
          :size="14"
          class="shrink-0 transition-transform"
          :class="{ 'rotate-90': expanded }"
        />
      </button>
      <div v-if="expanded" class="mt-1 ml-1.5 flex min-w-0 flex-col gap-2 border-l border-gray-200 pl-3">
        <template v-for="block in blocks" :key="block.key">
          <AgentReasoningBlock
            v-if="block.type === 'reasoning'"
            :item="block.item"
            :completed="groupStatus === 'completed'"
          />
          <AgentToolBlock v-else-if="block.type === 'tool' || block.type === 'web_search'" :block="block" />
          <AgentMailMessage
            v-else-if="block.type === 'context_message' && isAgentMailMessage(block.item)"
            compact
            :item="block.item"
          />
          <MessageOutput v-else-if="block.type === 'context_message'" :item="block.item" :show-tools="false" compact />
          <div v-else-if="block.type === 'permission'" class="text-sm text-amber-600">
            {{
              block.item.status === 'pending'
                ? $t('status.waitingToolPermission')
                : block.item.status === 'approved'
                  ? $t('status.accessAllowed')
                  : $t('status.accessDenied')
            }}
          </div>
          <UnknownOutput v-else :item="block.item" />
        </template>
      </div>
    </template>
  </div>
</template>
