<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { toolDetails, toolResultHint, type ToolBlock } from '../../utils/toolCatalog/toolDetails';
import { toolDisplay } from '../../utils/toolCatalog/toolCatalog.ts';
import { agentToolHeading } from '../../utils';
import AgentWebSearchBlock from '../web-search/AgentWebSearchBlock.vue';
import AgentTeamToolCard from './AgentTeamToolCard.vue';

const props = defineProps<{ block: ToolBlock }>();
const expanded = ref(false);
const details = computed(() => toolDetails(props.block));
const heading = computed(() => props.block.type === 'tool' ? agentToolHeading(props.block) : undefined);
const meta = computed(() => props.block.type === 'tool' ? toolResultHint(props.block) : '');
</script>

<template>
  <AgentWebSearchBlock v-if="details?.kind === 'web_search'" :details="details" />
  <div v-else-if="block.type === 'tool' && heading" class="min-w-0 text-[15px] text-gray-600">
    <button
      class="group flex h-6 max-w-full items-center gap-1.5 text-left text-gray-500 hover:text-gray-700"
      type="button"
      :disabled="!details"
      :aria-expanded="details ? expanded : undefined"
      @click="expanded = !expanded"
    >
      <component :is="toolDisplay(block.call.name).icon" :size="14" class="shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="shrink-0 whitespace-nowrap" :title="heading.title">{{ heading.title }}</span>
        <code v-if="heading.detail" class="min-w-0 truncate font-mono text-sm" :title="heading.detail">{{
          heading.detail
        }}</code>
      </span>
      <span v-if="meta" class="max-w-[45%] shrink-0 truncate text-sm" :class="{ 'text-red-600': block.status === 'error' }" :title="meta">{{ meta }}</span>
      <ChevronRight
        v-if="details"
        :size="14"
        class="shrink-0 text-gray-400 transition-transform group-hover:text-gray-600"
        :class="{ 'rotate-90': expanded }"
      />
    </button>

    <div v-if="expanded && details" class="mt-2 min-w-0">
      <div
        v-if="details.kind === 'error'"
        class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700"
      >
        {{ details.text }}
      </div>

      <AgentTeamToolCard v-else-if="details.kind === 'team'" :card="details.card" />

      <div
        v-else-if="details.kind === 'web_fetch'"
        class="tool-output min-w-0 overflow-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
      >
        <pre class="whitespace-pre-wrap wrap-anywhere text-sm">{{ details.text }}</pre>
      </div>

      <template v-else-if="details.kind === 'shell'">
        <div
          class="overflow-hidden rounded-md border border-gray-200 bg-white font-mono text-[13px] leading-5"
        >
          <div v-if="details.command" class="flex border-b border-gray-200">
            <span class="w-10 shrink-0 px-2 py-1 text-gray-400">IN</span>
            <pre
              class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap wrap-break-word px-2 py-1 text-gray-700"
              >{{ details.command }}</pre>
          </div>
          <div v-if="details.output" class="flex">
            <span class="w-10 shrink-0 px-2 py-1 text-gray-400">OUT</span>
            <pre
              class="tool-output min-w-0 flex-1 overflow-auto whitespace-pre-wrap wrap-break-word px-2 py-1 text-gray-600"
              >{{ details.output }}</pre>
          </div>
        </div>
      </template>

      <div v-else-if="details.kind === 'patch'" class="space-y-3">
        <div
          v-for="(patch, patchIndex) in details.patches"
          :key="`${patch.path}:${patchIndex}`"
        >
          <div class="mb-1 font-mono text-[13px] text-gray-500">{{ patch.path }}</div>
          <div
            v-for="(replacement, replacementIndex) in patch.replacements"
            :key="replacementIndex"
            class="patch-preview grid overflow-hidden rounded-md border md:grid-cols-2"
          >
            <pre
              class="tool-output border-b border-red-950/80 bg-red-950/25 p-2 text-red-100 md:border-b-0 md:border-r"
            >- {{ replacement.oldText }}</pre>
            <pre class="tool-output bg-emerald-950/25 p-2 text-emerald-100">+ {{ replacement.newText }}</pre>
          </div>
        </div>
      </div>

      <pre v-else-if="details.kind === 'text'" class="tool-output content-panel">{{ details.text }}</pre>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.patch-preview {
  border-color: #374151;
  background: #111827;
}

.content-panel {
  @apply overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[13px] leading-5 text-gray-600;
}

.tool-output {
  max-height: 22rem;
  scrollbar-width: thin;
  scrollbar-color: rgb(203 213 225 / 0.8) transparent;
}
</style>
