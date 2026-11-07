<script setup lang="ts">
import { computed, inject, shallowRef, watch } from 'vue';
import { FileDiff } from '@lucide/vue';
import { useRouter } from 'vue-router';
import type { ReviewFile } from '../../../../../shared/agent-ipc';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { reviewTargetKey } from './reviewNavigation';

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
  <section v-if="files.length" class="mt-3 w-full min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white text-sm">
    <header class="flex items-center gap-3 px-3 py-2.5">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
        <FileDiff :size="16" />
      </span>
      <div class="min-w-0">
        <p class="font-medium text-gray-900">{{ $t('dynamic.reviewFileCount', { count: files.length }) }}</p>
        <p class="flex gap-2 text-xs">
          <span class="text-green-700">+{{ totals.additions }}</span>
          <span class="text-red-700">−{{ totals.deletions }}</span>
        </p>
      </div>
    </header>
    <ul class="max-h-44 overflow-y-auto border-t border-gray-100 px-3">
      <li v-for="file in files" :key="file.id" class="border-b border-gray-100 last:border-b-0">
        <button
          class="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-2 text-left text-xs hover:bg-gray-50"
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
  </section>
</template>
