<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AIResponseContext, AIResponseContent } from '../../types/aiResponse';
import { readInputContentDisplayText } from '../../utils/aiResponse';

const props = defineProps<{ contexts: AIResponseContext[]; activeResponseId?: string | null }>();
const emit = defineEmits<{ jump: [responseId: string] }>();
const listRef = ref<HTMLElement>();
const jumpContexts = computed(() =>
  props.contexts.filter((context) =>
    context.input.some((item) => item.type === 'message' && item.role === 'user'),
  ),
);

const title = (context: AIResponseContext, index: number) => {
  const item = context.input.find(
    (candidate) => candidate.type === 'message' && candidate.role === 'user',
  );
  if (!item || item.type !== 'message' || !('content' in item) || !Array.isArray(item.content))
    return `Response ${index + 1}`;
  return (
    readInputContentDisplayText(item.content as AIResponseContent[]) || `Response ${index + 1}`
  );
};

const scrollActiveIntoView = () => {
  requestAnimationFrame(() => {
    const list = listRef.value;
    const active = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (list && active)
      list.scrollTop = active.offsetTop - (list.clientHeight - active.clientHeight) / 2;
  });
};
</script>

<template>
  <aside
    v-if="jumpContexts.length > 0"
    class="group pointer-events-none absolute inset-y-5 right-7 z-10 hidden w-5 items-center lg:flex"
    aria-label="Response jump navigation"
  >
    <div
      class="pointer-events-auto flex w-5 flex-col py-2"
      :style="{ height: `min(100%, ${jumpContexts.length * 8 + 16}px)` }"
      @mouseenter="scrollActiveIntoView"
      @focusin="scrollActiveIntoView"
    >
      <button
        v-for="(context, index) in jumpContexts"
        :key="context.response.id"
        type="button"
        class="flex min-h-0 w-5 flex-1 items-center justify-center"
        :aria-label="
          $t('dynamic.jumpToMessage', { index: index + 1, title: title(context, index) })
        "
        :aria-current="context.response.id === activeResponseId ? 'step' : undefined"
        @click="emit('jump', context.response.id)"
      >
        <span
          class="h-0.5 w-5 bg-gray-300"
          :class="{ 'bg-gray-950': context.response.id === activeResponseId }"
        />
      </button>
    </div>
    <div
      ref="listRef"
      class="pointer-events-auto absolute top-1/2 right-0 z-20 hidden max-h-full w-80 -translate-y-1/2 flex-col gap-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-xl group-hover:flex group-focus-within:flex"
    >
      <button
        v-for="(context, index) in jumpContexts"
        :key="context.response.id"
        type="button"
        class="shrink-0 rounded-md px-2 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
        :class="
          context.response.id === activeResponseId
            ? 'bg-gray-100'
            : 'hover:bg-gray-200'
        "
        :aria-current="context.response.id === activeResponseId ? 'step' : undefined"
        @click="emit('jump', context.response.id)"
      >
        <span class="block truncate text-sm font-medium">{{ title(context, index) }}</span>
      </button>
    </div>
  </aside>
</template>
