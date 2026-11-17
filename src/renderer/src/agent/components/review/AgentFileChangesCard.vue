<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { ChevronDown, FileDiff } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { reviewTargetKey, type ReviewRun, type ReviewTarget } from './reviewNavigation';
import { useFileChanges } from './useFileChanges';
import AgentResultCard from '../conversation/AgentResultCard.vue';

const props = defineProps<{ runs: ReviewRun[] }>();
const previewCount = 2;
const files = useFileChanges(() => props.runs);
const expanded = ref(false);
const visibleFiles = computed(() => expanded.value ? files.value : files.value.slice(0, previewCount));
const reviewTarget = inject(reviewTargetKey);
const router = useRouter();

async function openFile(target: ReviewTarget) {
  if (!reviewTarget) return;
  reviewTarget.value = { ...target };
  if (router.currentRoute.value.name !== 'aiAgentRightSidebarHome') {
    await router.push({ name: 'aiAgentRightSidebarHome' });
  }
}
const totals = computed(() => files.value.reduce(
  (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
  { additions: 0, deletions: 0 },
));

</script>

<template>
  <AgentResultCard v-if="files.length">
    <template #icon><FileDiff :size="16" /></template>
    <template #title>{{ $t('dynamic.reviewFileCount', { count: files.length }) }}</template>
    <template #detail>
      <span class="flex gap-2 text-xs">
        <span class="text-green-700">+{{ totals.additions }}</span>
        <span class="text-red-700">−{{ totals.deletions }}</span>
      </span>
    </template>
    <ul class="inset-scrollbar max-h-56 divide-y divide-gray-100 overflow-y-auto">
      <li v-for="file in visibleFiles" :key="file.key">
        <component :is="file.changes.length > 1 ? 'details' : 'div'" class="group">
          <component
            :is="file.changes.length > 1 ? 'summary' : 'button'"
            class="flex min-h-11 w-full min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
            :type="file.changes.length === 1 ? 'button' : undefined"
            :title="file.path"
            @click="file.changes.length === 1 && openFile(file.changes[0]!.target)"
          >
            <span class="min-w-0 flex-1 truncate text-gray-700">{{ file.path }}</span>
            <template v-if="file.available">
              <span class="shrink-0 text-green-700">+{{ file.additions }}</span>
              <span class="shrink-0 text-red-700">−{{ file.deletions }}</span>
            </template>
            <ChevronDown v-if="file.changes.length > 1" :size="14" class="shrink-0 transition-transform group-open:rotate-180" />
          </component>
          <template v-if="file.changes.length > 1">
            <button v-for="(change, index) in file.changes" :key="change.target.fileId"
              class="flex w-full items-center gap-2 border-t border-gray-100 py-2 pr-3 pl-6 text-left text-xs text-gray-600 hover:bg-gray-50"
              type="button" @click="openFile(change.target)">
              <span class="flex-1">{{ $t('dynamic.reviewChangeNumber', { number: index + 1 }) }}</span>
              <template v-if="!change.file.unavailable">
                <span class="shrink-0 text-green-700">+{{ change.file.additions }}</span>
                <span class="shrink-0 text-red-700">−{{ change.file.deletions }}</span>
              </template>
            </button>
          </template>
        </component>
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
