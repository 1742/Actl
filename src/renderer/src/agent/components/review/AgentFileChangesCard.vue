<script setup lang="ts">
import { computed, inject, shallowRef, watch } from 'vue';
import { FileDiff } from '@lucide/vue';
import { useRouter } from 'vue-router';
import type { ReviewFile } from '../../../../../shared/agent/review';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { reviewTargetKey } from './reviewNavigation';
import AgentResultCard from '../conversation/AgentResultCard.vue';

const props = defineProps<{ sessionId: string; runId: string }>();
const files = shallowRef<ReviewFile[]>([]);
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
    <ul class="max-h-44 overflow-y-auto">
      <li v-for="file in files" :key="file.id" class="border-b border-gray-100 last:border-b-0">
        <button
          class="agent-result-row"
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
  </AgentResultCard>
</template>
