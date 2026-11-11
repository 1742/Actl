<script setup lang="ts">
import { computed } from 'vue';
import type { AIMessageItem } from './types';
import { readContentText } from '../../utils/aiResponse.ts';
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
const text = computed(() => readContentText(props.item.content, 'output_text'));
</script>

<template>
  <p v-if="item.source?.kind === 'mail'" class="text-sm text-gray-500">
    {{ $t('agents.receivedMail') }} · {{ item.source.subject }}
  </p>
  <div v-else-if="text && item.role === 'user'" class="flex flex-col items-end">
    <MessageAuthor :item="item" />
    <div class="max-w-[82%] rounded-xl bg-gray-100 px-3 py-2 text-sm whitespace-pre-wrap wrap-break-word">{{ text }}</div>
  </div>
  <div v-else-if="text" class="group/message flex flex-col items-start text-gray-900">
    <div class="w-full text-[15px] leading-7 text-gray-950">
      <MessageHtml :html-string="text" :is-invert="false" />
    </div>
    <slot name="footer" :content="text">
      <MessageTools v-if="showTools" :content="text" :timestamp="timestamp" />
    </slot>
  </div>
</template>
