<script setup lang="ts">
import { computed } from 'vue';
import type { AIMessageItem } from './types';
import { conversationMessageKind, readContentText } from '../../utils/aiResponse.ts';
import MessageHtml from './MessageHtml.vue';
import MessageTools from './MessageTools.vue';
import MessageAuthor from './MessageAuthor.vue';

const props = withDefaults(
  defineProps<{
    item: AIMessageItem;
    showTools?: boolean;
    timestamp?: string;
  }>(),
  {
    showTools: true,
  },
);
const kind = computed(() => conversationMessageKind(props.item));
const text = computed(() =>
  readContentText(props.item.content, 'output_text') || readContentText(props.item.content, 'input_text'),
);
</script>

<template>
  <div v-if="text && kind === 'user'" class="flex flex-col items-end">
    <div class="max-w-[82%] rounded-xl bg-gray-100 px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word">{{ text }}</div>
  </div>
  <div v-else-if="text && kind === 'agent'" class="group/message max-w-full border-l-2 border-gray-200 pl-3">
    <MessageAuthor :item="item" />
    <div class="text-sm leading-relaxed text-gray-800 whitespace-pre-wrap wrap-break-word">{{ text }}</div>
    <MessageTools v-if="showTools" :content="text" :timestamp="timestamp" />
  </div>
  <div v-else-if="text" class="group/message flex flex-col items-start text-gray-900">
    <MessageAuthor v-if="kind === 'runtime' && item.role === 'user'" :item="item" />
    <div class="w-full text-[15px] leading-7 text-gray-950">
      <MessageHtml :html-string="text" :is-invert="false" />
    </div>
    <slot name="footer" :content="text">
      <MessageTools v-if="showTools" :content="text" :timestamp="timestamp" />
    </slot>
  </div>
</template>
