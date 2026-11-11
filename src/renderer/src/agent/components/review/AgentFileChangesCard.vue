<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from 'vue';
import { ChevronDown, FileDiff } from '@lucide/vue';
import { useRouter } from 'vue-router';
import type { ReviewFile } from '../../../../../shared/agent/review';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { reviewTargetKey } from './reviewNavigation';
import AgentResultCard from '../conversation/AgentResultCard.vue';

const props = defineProps<{ sessionId: string; runId: string }>();
const previewCount = 2;
const files = shallowRef<ReviewFile[]>([]);
const expanded = ref(false);
const visibleFiles = computed(() => expanded.value ? files.value : files.value.slice(0, previewCount));
const reviewTarget = inject(reviewTargetKey);
const router = useRouter();

async function openFile(fileId: string) {
  if (!reviewTarget) return;
  reviewTarget.value = { sessionId: props.sessionId, runId: props.runId, fileId };
  if (router.currentRoute.value.name !== 'aiAgentRightSidebarHome') {
    await router.push({ name: 'aiAgentRightSidebarHome' });
  }
}
const totals = computed(() => files.value.reduce(
  (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
  { additions: 0, deletions: 0 },
));

watch(() => [props.sessionId, props.runId] as const, async ([sessionId, runId], _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  expanded.value = false;
  files.value = [];
  if (!sessionId || !runId || runId.startsWith('local-')) return;
  try {
    const { client } = getAgentRuntimeContext('local');
    const review = await client.getSessionReview(sessionId, { runId });
    if (current) files.value = review.files;
  } catch {
    // The summary is supplementary to the message.
  }
}, { immediate: true });
</script>

<template>
  <AgentResultCard v-if="files.length" class="mt-3">
    <template #icon><FileDiff :size="16" /></template>
    <template #title>{{ $t('dynamic.reviewFileCount', { count: files.length }) }}</template>
    <template #detail>
      <span class="flex gap-2 text-xs">
        <span class="text-green-700">+{{ totals.additions }}</span>
        <span class="text-red-700">−{{ totals.deletions }}</span>
      </span>
    </template>
    <ul class="inset-scrollbar max-h-56 divide-y divide-gray-100 overflow-y-auto">
      <li v-for="file in visibleFiles" :key="file.id">
        <button
          class="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
          type="button"
          :title="file.path"
          @click="openFile(file.id)"
        >
          <span class="min-w-0 flex-1 truncate text-gray-700">{{ file.path }}</span>
          <template v-if="!file.unavailable">
            <span class="shrink-0 text-green-700">+{{ file.additions }}</span>
            <span class="shrink-0 text-red-700">−{{ file.deletions }}</span>
          </template>
        </button>
      </li>
    </ul>
    <button
      v-if="files.length > previewCount"
      class="agent-result-row border-t border-gray-100 text-gray-500 hover:text-gray-800"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{
        expanded ? $t('ui.hideChangedFiles') : $t('dynamic.moreChangedFiles', { count: files.length - previewCount })
      }}</span>
      <ChevronDown :size="14" class="transition-transform" :class="{ 'rotate-180': expanded }" />
    </button>
  </AgentResultCard>
</template>
