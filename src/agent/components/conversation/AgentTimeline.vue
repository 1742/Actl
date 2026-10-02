<script setup lang="ts">
import { computed } from 'vue';
import MessageOutput from '../AIResponse/MessageOutput.vue';
import UnknownOutput from '../AIResponse/UnknownOutput.vue';
import type { AIResponseContext } from '../../types/aiResponse.ts';
import { buildAgentOutputBlocks } from '../../utils';
import AgentReasoningBlock from './AgentReasoningBlock.vue';
import AgentToolBlock from './AgentToolBlock.vue';
import AgentWebSearchBlock from './AgentWebSearchBlock.vue';

const props = defineProps<{ context: AIResponseContext }>();
const blocks = computed(() => buildAgentOutputBlocks(props.context));

const dotClass = (type: string, status?: string) => {
  if (type !== 'tool') return 'border-gray-500 bg-gray-500';
  if (status === 'success') return 'border-emerald-500 bg-emerald-500';
  if (status === 'error' || status === 'incomplete') return 'border-red-500 bg-red-500';
  return 'border-amber-400 bg-amber-400';
};
</script>

<template>
  <div v-if="blocks.length" class="agent-timeline">
    <div v-for="(block, index) in blocks" :key="block.key" class="timeline-row min-w-0">
      <div class="timeline-marker" aria-hidden="true">
        <span v-if="index < blocks.length - 1" class="timeline-line" />
        <span
          class="timeline-dot rounded-full border"
          :class="dotClass(block.type, block.type === 'tool' ? block.status : undefined)"
        />
      </div>

      <div class="min-w-0">
        <MessageOutput v-if="block.type === 'message'" :item="block.item" />
        <AgentReasoningBlock v-else-if="block.type === 'reasoning'" :item="block.item" />
        <AgentWebSearchBlock v-else-if="block.type === 'web_search'" :item="block.item" />
        <AgentToolBlock v-else-if="block.type === 'tool'" :block="block" />
        <div v-else-if="block.type === 'permission'" class="text-xs text-amber-600">
          {{
            block.item.status === 'pending'
              ? $t('status.waitingToolPermission')
              : block.item.status === 'approved'
                ? $t('status.accessAllowed')
                : $t('status.accessDenied')
          }}
        </div>
        <UnknownOutput v-else :item="block.item" />
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.agent-timeline {
  @apply flex min-w-0 flex-col gap-4;
}

.timeline-row {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr);
  column-gap: 0.75rem;
  min-height: 0.75rem;
}

.timeline-marker {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.timeline-line {
  position: absolute;
  left: 50%;
  top: 0.65rem;
  width: 1px;
  height: calc(100% + 1rem);
  background: rgb(229 231 235);
  transform: translateX(-50%);
}

.timeline-dot {
  position: relative;
  margin-top: 0.4rem;
  width: 0.5rem;
  height: 0.5rem;
  z-index: 1;
}
</style>
