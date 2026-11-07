<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from 'vue';
import { FileDiff, RefreshCw } from '@lucide/vue';
import type { ReviewLine, SessionReview } from '../../../../../shared/agent/review';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import { reviewTargetKey } from './reviewNavigation';

const store = useAgentStore();
const sessionId = computed(() => store.session?.runtimeId);
const reviewTarget = inject(reviewTargetKey);
const target = computed(() => {
  const request = reviewTarget?.value;
  return request?.sessionId === sessionId.value ? request : undefined;
});
const latest = computed(() => store.responses.at(-1)?.response);
const review = shallowRef<SessionReview>();
const lines = shallowRef<ReviewLine[]>([]);
const selectedId = ref('');
const loading = ref(false);
const loadingDiff = ref(false);
const failed = ref(false);
const diffFailed = ref(false);
const refresh = ref(0);
const { client } = getAgentRuntimeContext('local');
const selectedFile = computed(() => review.value?.files.find((file) => file.id === selectedId.value));

watch([sessionId, target, () => target.value ? undefined : latest.value?.id, () => target.value ? undefined : latest.value?.status, refresh], async ([id, requested], _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  const previousId = selectedId.value;
  review.value = undefined;
  selectedId.value = '';
  failed.value = false;
  loading.value = Boolean(id);
  if (!id) return;
  try {
    const result = await client.getSessionReview(id, requested ? { runId: requested.runId } : undefined);
    if (!current) return;
    review.value = result;
    const preferredId = requested?.fileId ?? previousId;
    selectedId.value = result.files.find((file) => file.id === preferredId)?.id ?? result.files[0]?.id ?? '';
  } catch {
    if (current) failed.value = true;
  } finally {
    if (current) loading.value = false;
  }
}, { immediate: true });

watch([sessionId, selectedFile, () => review.value?.runId], async ([id, file, runId], _, onCleanup) => {
  let current = true;
  onCleanup(() => { current = false; });
  lines.value = [];
  diffFailed.value = false;
  loadingDiff.value = Boolean(id && file && !file.unavailable);
  if (!id || !file || file.unavailable) return;
  try {
    const result = await client.getSessionReview(id, { fileId: file.id, ...(runId ? { runId } : {}) });
    if (!current) return;
    if (result.runId !== runId) {
      refresh.value++;
      return;
    }
    lines.value = result.lines ?? [];
  } catch {
    if (current) diffFailed.value = true;
  } finally {
    if (current) loadingDiff.value = false;
  }
});
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-white text-sm">
    <header class="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
      <span class="flex min-w-0 items-center gap-2 rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-700 shadow-xs">
        <FileDiff :size="14" class="shrink-0" />
        <span class="truncate">{{ $t(target ? 'ui.review' : 'ui.lastRunChanges') }}</span>
      </span>
      <button
        class="flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-600 shadow-xs enabled:hover:bg-gray-100 disabled:opacity-50"
        type="button" :disabled="!sessionId || loading" :aria-label="$t('ui.refresh')" :title="$t('ui.refresh')"
        @click="refresh++"
      >
        <RefreshCw :size="14" />
      </button>
    </header>
    <p v-if="loading || failed || !review?.files.length" role="status" class="px-4 py-8 text-center text-xs text-gray-500">
      {{ $t(loading ? 'ui.loadingRunChanges' : failed ? 'ui.failedRunChanges' : 'ui.noRunChanges') }}
    </p>
    <template v-else>
      <div class="px-3">
        <select
          v-model="selectedId"
          class="w-full truncate rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700"
          :aria-label="$t('ui.files')"
          :title="selectedFile?.path"
        >
          <option v-for="file in review.files" :key="file.id" :value="file.id">{{ file.path }}</option>
        </select>
      </div>
      <p v-if="loadingDiff || diffFailed || selectedFile?.unavailable || !lines.length" role="status" class="px-4 py-6 text-center text-xs text-gray-500">
        {{ $t(loadingDiff ? 'ui.loadingRunChanges' : diffFailed ? 'ui.failedRunChanges' : selectedFile?.unavailable ? 'ui.unavailableRunDiff' : 'ui.emptyRunDiff') }}
      </p>
      <div v-else class="review-diff mx-2 my-2 min-h-0 flex-1 overflow-auto rounded-lg border border-gray-200">
        <table class="w-max min-w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            <tr v-for="(line, index) in lines" :key="index"
              :class="line.kind === 'added' ? 'bg-green-100 text-green-950' : line.kind === 'removed' ? 'bg-red-100 text-red-950' : 'text-gray-700'"
            >
              <td v-if="line.kind === 'gap'" colspan="4" class="bg-gray-50 px-2 text-gray-500">…</td>
              <template v-else>
                <td class="select-none border-r border-gray-200 px-2 text-right text-gray-500">{{ line.oldLine }}</td>
                <td class="select-none border-r border-gray-200 px-2 text-right text-gray-500">{{ line.newLine }}</td>
                <td class="select-none px-1">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : '' }}</td>
                <td class="whitespace-pre pr-3">{{ line.text.replace(/\r?\n$/, '') }}</td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.review-diff::-webkit-scrollbar {
  height: 4px;
}

.review-diff::-webkit-scrollbar-track {
  margin: 6px;
}
</style>
