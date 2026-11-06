<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { currentLocale } from '../../../i18n';
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  LoaderCircle,
  MessageCircle,
  Package,
  Paperclip,
  Plug,
} from '@lucide/vue';
import type { ComposerMenuCandidate } from './composerReferenceMenu';

type ActionCandidate = Extract<
  ComposerMenuCandidate,
  { type: 'attachment' | 'recent-chats' | 'compress' }
>;
type ItemCandidate = Exclude<ComposerMenuCandidate, ActionCandidate>;
type McpCandidate = Extract<ItemCandidate, { type: 'mcp' }>;
type ListedCandidate = Exclude<ItemCandidate, McpCandidate>;

const props = defineProps<{
  type: 'skill' | 'file';
  level: 'root' | 'mcp';
  query: string;
  candidates: ComposerMenuCandidate[];
  activeKey: string;
  disabledKeys: Set<string>;
  selectedSkillIds: Set<string>;
  selectedMcpNames: Set<string>;
  selectedSkillCount: number;
  selectedMcpCount: number;
  mcpServerCount: number;
  skillsLoading: boolean;
  skillsError: string;
  mcpLoading: boolean;
  mcpError: string;
  projectId: string;
  filesLoading: boolean;
  filesError: string;
  filesTruncated: boolean;
  compressionPercent: number;
}>();

const emit = defineEmits<{
  active: [key: string];
  select: [candidate: ComposerMenuCandidate];
  back: [];
}>();

const listRef = ref<HTMLElement>();
const actionCandidates = computed(() =>
  props.candidates.filter(
    (candidate): candidate is ActionCandidate =>
      candidate.type === 'attachment' ||
      candidate.type === 'recent-chats' ||
      candidate.type === 'compress',
  ),
);
const itemCandidates = computed(() =>
  props.candidates.filter(
    (candidate): candidate is ItemCandidate =>
      candidate.type !== 'attachment' &&
      candidate.type !== 'recent-chats' &&
      candidate.type !== 'compress',
  ),
);
const mcpCandidate = computed(() =>
  itemCandidates.value.find((candidate): candidate is McpCandidate => candidate.type === 'mcp'),
);
const listedCandidates = computed(() =>
  itemCandidates.value.filter(
    (candidate): candidate is ListedCandidate => candidate.type !== 'mcp',
  ),
);
const hasSkills = computed(() =>
  listedCandidates.value.some((candidate) => candidate.type === 'skill'),
);

async function scrollToCandidate(key: string) {
  await nextTick();
  const element = Array.from(
    listRef.value?.querySelectorAll<HTMLElement>('[data-candidate-key]') || [],
  ).find((candidate) => candidate.dataset.candidateKey === key);
  element?.scrollIntoView({ block: 'nearest' });
}

defineExpose({ scrollToCandidate });
</script>

<template>
  <div>
    <div ref="listRef" class="min-h-0 overflow-y-auto px-1.5 py-1.5">
      <template v-if="type === 'file'">
        <div class="flex items-center justify-between gap-2 px-2 py-2 text-xs text-gray-500">
          <span class="font-medium">{{ $t('ui.workspaceFiles') }}</span>
          <span v-if="filesTruncated">{{ $t('ui.onlySomeResultsAreShown') }}</span>
        </div>
        <div v-if="!projectId" class="menu-status text-amber-700">
          <CircleAlert :size="15" /><span>{{ $t('ui.thisConversationHasNoWorkspace') }}</span>
        </div>
        <div v-else-if="filesLoading" class="menu-status">
          <LoaderCircle :size="15" class="animate-spin" /><span>{{
            $t('ui.searchingWorkspaceFiles')
          }}</span>
        </div>
        <div v-else-if="filesError" class="menu-status text-red-600">
          <CircleAlert :size="15" /><span>{{ filesError }}</span>
        </div>
        <div v-else-if="!listedCandidates.length" class="menu-status">
          {{ $t('dynamic.noMatchingResults', { query }) }}
        </div>
      </template>

      <template v-else-if="level === 'root'">
        <div>
          <button
            v-for="candidate in actionCandidates"
            :key="candidate.key"
            :data-candidate-key="candidate.key"
            class="mt-1 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-gray-800 transition-colors first:mt-0 disabled:cursor-not-allowed disabled:text-gray-400"
            :class="candidate.key === activeKey ? 'bg-gray-100' : 'hover:bg-gray-50'"
            :disabled="disabledKeys.has(candidate.key)"
            type="button"
            @mouseenter="emit('active', candidate.key)"
            @mousedown.prevent
            @click="emit('select', candidate)"
          >
            <Paperclip v-if="candidate.type === 'attachment'" :size="15" class="shrink-0" />
            <MessageCircle
              v-else-if="candidate.type === 'recent-chats'"
              :size="15"
              class="shrink-0"
            />
            <span
              v-else
              class="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
              :style="{
                background: `conic-gradient(#4b5563 ${Math.min(100, compressionPercent)}%, #e5e7eb 0)`,
              }"
            >
              <span class="h-2.5 w-2.5 rounded-full bg-white" />
            </span>
            <span class="shrink-0 text-sm font-medium">{{
              candidate.type === 'attachment'
                ? $t('ui.files')
                : candidate.type === 'recent-chats'
                  ? $t('ui.recentChats')
                  : $t('ui.compress')
            }}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{
              candidate.type === 'attachment'
                ? $t('ui.chooseAFileFromThisDevice')
                : candidate.type === 'recent-chats'
                  ? $t('ui.viewOrSearchRecentConversations')
                  : $t('dynamic.compressionUsage', { percent: compressionPercent })
            }}</span>
          </button>
        </div>
        <button
          v-if="mcpCandidate"
          :data-candidate-key="mcpCandidate.key"
          class="mt-1 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-gray-800 transition-colors"
          :class="mcpCandidate.key === activeKey ? 'bg-gray-100' : 'hover:bg-gray-50'"
          type="button"
          @mouseenter="emit('active', mcpCandidate.key)"
          @mousedown.prevent
          @click="emit('select', mcpCandidate)"
        >
          <Plug :size="15" class="shrink-0" />
          <span class="shrink-0 text-sm font-medium">MCP</span>
          <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{
            mcpLoading
              ? $t('ui.loadingDots')
              : $t('dynamic.serviceCount', { count: mcpServerCount })
          }}</span>
          <ChevronRight :size="15" class="shrink-0 text-gray-400" />
        </button>
        <div class="mt-1 flex items-center justify-between px-2 pb-1.5 pt-2">
          <span class="text-sm font-bold">Skills</span>
          <span class="text-xs text-gray-400">{{ selectedSkillCount }}/8</span>
        </div>
        <div v-if="skillsLoading" class="menu-status">
          <LoaderCircle :size="15" class="animate-spin" /><span>{{ $t('ui.loadingSkills') }}</span>
        </div>
        <div v-else-if="skillsError" class="menu-status text-red-600">
          <CircleAlert :size="15" /><span>{{ skillsError }}</span>
        </div>
        <div v-else-if="!hasSkills" class="menu-status">
          {{ query ? $t('dynamic.noMatchingSkill', { query }) : $t('ui.noSkills') }}
        </div>
      </template>

      <template v-else>
        <button
          class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50"
          type="button"
          @mousedown.prevent
          @click="emit('back')"
        >
          <ArrowLeft :size="16" /><span>MCP Servers</span
          ><span class="ml-auto text-xs font-normal text-gray-400">{{ selectedMcpCount }}/8</span>
        </button>
        <div v-if="mcpLoading" class="menu-status">
          <LoaderCircle :size="15" class="animate-spin" /><span>{{
            $t('ui.loadingMcpServers')
          }}</span>
        </div>
        <div v-else-if="mcpError" class="menu-status text-red-600">
          <CircleAlert :size="15" /><span>{{ mcpError }}</span>
        </div>
        <div v-else-if="!listedCandidates.length" class="menu-status">
          {{ query ? $t('dynamic.noMatchingMcp', { query }) : $t('ui.noMcpServers') }}
        </div>
      </template>

      <button
        v-for="candidate in listedCandidates"
        :key="candidate.key"
        :data-candidate-key="candidate.key"
        class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors"
        :class="[
          candidate.key === activeKey ? 'bg-gray-100' : 'hover:bg-gray-50',
          disabledKeys.has(candidate.key) ? 'cursor-not-allowed text-gray-400' : 'text-gray-800',
        ]"
        :disabled="disabledKeys.has(candidate.key)"
        type="button"
        @mouseenter="emit('active', candidate.key)"
        @mousedown.prevent
        @click="emit('select', candidate)"
      >
        <Package v-if="candidate.type === 'skill'" :size="15" class="shrink-0" />
        <Plug v-else-if="candidate.type === 'mcp_server'" :size="15" class="shrink-0" />
        <FileText v-else :size="15" class="shrink-0" />
        <template v-if="candidate.type === 'skill'">
          <span class="shrink-0 text-sm font-medium">{{ candidate.item.name }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{
            currentLocale === 'zh-CN'
              ? candidate.item.description_zh || candidate.item.description
              : candidate.item.description || candidate.item.description_zh
          }}</span>
          <span v-if="selectedSkillIds.has(candidate.item.id)" class="shrink-0 text-xs">{{
            $t('ui.referenced')
          }}</span>
        </template>
        <template v-else-if="candidate.type === 'mcp_server'">
          <span class="shrink-0 text-sm font-medium">{{ candidate.item.name }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{
            candidate.item.connected
              ? $t('dynamic.toolCount', { count: candidate.item.toolCount })
              : $t('ui.disconnected')
          }}</span>
          <span v-if="selectedMcpNames.has(candidate.item.name)" class="shrink-0 text-xs">{{
            $t('ui.referenced')
          }}</span>
        </template>
        <template v-else>
          <span class="shrink-0 text-sm font-medium">{{ candidate.item.name }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-gray-400">{{
            candidate.item.path
          }}</span>
        </template>
      </button>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.menu-status {
  @apply flex min-h-18 items-center justify-center gap-2 px-4 py-3 text-sm text-gray-500;
}
</style>
