<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ArrowDown } from '@lucide/vue';
import type { SessionContextCompression } from '../../types/index.ts';
import type { AIFileContent, AIMessageItem, AIResponseContext } from '../../types/aiResponse.ts';
import { readInputContentDisplayText } from '../../utils/aiResponse.ts';
import InputMessageContent from './InputMessageContent.vue';
import MessageTools from './MessageTools.vue';
import RunJumpSidebar from './RunJumpSidebar.vue';

const props = withDefaults(
  defineProps<{
    contexts: AIResponseContext[];
    bottomInset?: number;
    emptyText?: string;
    displayMode?: 'default' | 'compact';
    skillNames?: Record<string, string>;
    loadFilePreview?: (file: AIFileContent, sessionId: string) => Promise<string | undefined>;
    compressions?: SessionContextCompression[];
    compressionInProgress?: boolean;
  }>(),
  {
    bottomInset: 140,
    emptyText: tr('ui.howCanIHelp'),
    displayMode: 'default',
    skillNames: () => ({}),
    compressions: () => [],
    compressionInProgress: false,
  },
);
const emit = defineEmits<{
  downloadFile: [file: AIFileContent];
}>();

const scrollRef = ref<HTMLElement>();
const activeResponseId = ref<string>();
const isNearBottom = ref(true);
const bottomPadding = computed(() => `${props.bottomInset + 132}px`);

const inputMessages = (context: AIResponseContext) =>
  context.input.filter(
    (item): item is AIMessageItem => item.type === 'message' && item.role === 'user',
  );
const skillNames = (context: AIResponseContext) => {
  const skills = context.response.extensions?.skills;
  const responseSkillNames = !Array.isArray(skills)
    ? {}
    : Object.fromEntries(
        skills.flatMap((skill) => {
          if (!skill || typeof skill !== 'object') return [];
          const value = skill as Record<string, unknown>;
          return typeof value.id === 'string' && typeof value.name === 'string'
            ? [[value.id, value.name]]
            : [];
        }),
      );
  return { ...props.skillNames, ...responseSkillNames };
};
const messageText = (context: AIResponseContext, item: AIMessageItem) =>
  readInputContentDisplayText(item.content, skillNames(context));
const refreshPosition = () => {
  const scroller = scrollRef.value;
  if (!scroller) return;
  isNearBottom.value = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[data-response-id]'));
  if (!sections.length) return;
  const top = scroller.getBoundingClientRect().top;
  activeResponseId.value = sections.reduce((best, section) =>
    Math.abs(section.getBoundingClientRect().top - top - 24) <
    Math.abs(best.getBoundingClientRect().top - top - 24)
      ? section
      : best,
  ).dataset.responseId;
};

const jumpToResponse = async (responseId: string) => {
  activeResponseId.value = responseId;
  await nextTick();
  const escaped = CSS.escape(responseId);
  scrollRef.value
    ?.querySelector<HTMLElement>(`[data-response-id="${escaped}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

const scrollToBottom = () => {
  scrollRef.value?.scrollTo({ top: scrollRef.value.scrollHeight, behavior: 'smooth' });
};

onMounted(refreshPosition);
watch(
  () => JSON.stringify(props.contexts),
  async () => {
    const stick = isNearBottom.value;
    await nextTick();
    if (scrollRef.value && stick)
      scrollRef.value.scrollTo({ top: scrollRef.value.scrollHeight, behavior: 'instant' });
    refreshPosition();
  },
);
</script>

<template>
  <div class="relative min-h-0 w-full flex-1 bg-transparent">
    <div
      ref="scrollRef"
      class="h-full w-full overflow-y-auto scroll-smooth"
      @scroll.passive="refreshPosition"
    >
      <div
        v-if="!contexts.length"
        class="mx-auto flex h-full max-w-5xl items-center justify-center px-4 pt-8"
        :style="{ paddingBottom: bottomPadding }"
      >
        <h2 class="text-base font-semibold text-gray-800">{{ emptyText }}</h2>
      </div>
      <div
        v-else
        class="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 pt-8 sm:px-6 lg:px-14"
        :style="{ paddingBottom: bottomPadding }"
      >
        <template v-for="(context, contextIndex) in contexts" :key="context.response.id">
          <section :data-response-id="context.response.id" class="flex scroll-mt-5 flex-col gap-4">
            <div
              v-for="(item, index) in inputMessages(context)"
              :key="item.id || `${context.response.id}:input:${index}`"
              class="flex justify-end"
            >
              <div class="flex max-w-[82%] flex-col items-end sm:max-w-[72%]">
                <div v-if="item.content.length" class="max-w-full">
                  <InputMessageContent
                    :parts="item.content"
                    :skill-names="skillNames(context)"
                    :session-id="context.sessionId"
                    :load-file-preview="loadFilePreview"
                    @download-file="emit('downloadFile', $event)"
                  />
                </div>
                <MessageTools
                  v-if="messageText(context, item)"
                  :content="messageText(context, item)"
                />
              </div>
            </div>

            <slot name="output" :context="context" />
          </section>
          <div
            v-for="compression in compressions.filter(
              (item) => item.summarized_run_count === contextIndex + 1,
            )"
            :key="compression.created_at"
            class="py-1 text-xs text-gray-400"
          >
            <details class="group w-full text-gray-400">
              <summary
                class="flex cursor-pointer list-none items-center gap-3 text-gray-400 hover:text-gray-500"
              >
                <span class="h-px flex-1 bg-gray-200" />
                <span class="shrink-0">{{ $t('ui.contextCompressed') }}</span>
                <span class="h-px flex-1 bg-gray-200" />
              </summary>
              <div
                class="mt-2 max-h-56 w-full overflow-auto whitespace-pre-wrap wrap-break-word text-left text-xs text-gray-400"
              >
                {{ compression.summary }}
              </div>
            </details>
            <span class="h-px flex-1 bg-gray-200" />
          </div>
        </template>
        <div
          v-if="compressionInProgress"
          class="flex items-center gap-3 py-1 text-xs text-gray-400"
        >
          <span class="h-px flex-1 bg-gray-200" />
          <span class="shrink-0 text-center">{{ $t('ui.compressingContext') }}</span>
          <span class="h-px flex-1 bg-gray-200" />
        </div>
        <slot />
      </div>
    </div>
    <button
      v-if="contexts.length && !isNearBottom"
      class="absolute bottom-4 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
      type="button"
      :aria-label="$t('ui.scrollToBottom')"
      :title="$t('ui.scrollToBottom')"
      @click="scrollToBottom"
    >
      <ArrowDown :size="18" />
    </button>
    <RunJumpSidebar
      :contexts="contexts"
      :active-response-id="activeResponseId"
      @jump="jumpToResponse"
    />
  </div>
</template>
