<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight, Mail } from '@lucide/vue';
import { readContentText } from '../../utils/aiResponse';
import MessageTools from './MessageTools.vue';
import MessageAuthor from './MessageAuthor.vue';
import type { AgentMailMessageItem } from './types';

const props = defineProps<{
  item: AgentMailMessageItem;
  timestamp?: string;
}>();
const body = computed(() => readContentText(props.item.content));
const mail = computed(() => props.item.source);
</script>

<template>
  <details class="group/mail group/message min-w-0 max-w-full rounded-lg border border-gray-200 bg-gray-50/60">
    <summary class="flex cursor-pointer list-none flex-wrap items-center rounded-lg px-3 py-2 hover:bg-gray-100 gap-x-2 gap-y-1 text-xs text-gray-500">
      <div class="inline-flex min-w-0 max-w-full items-center gap-1.5">
        <Mail :size="14" class="shrink-0" aria-hidden="true" />
        <MessageAuthor :item="item" />
      </div>
      <span :class="{ 'font-medium text-amber-700': mail.purpose === 'urgent' }">
        {{ $t(`agents.messagePurpose.${mail.purpose}`) }}
      </span>
      <span class="tabular-nums">m#{{ mail.mailNumber }}</span>
      <span v-if="mail.replyTo != null">{{ $t('agents.inReplyTo', { message: `m#${mail.replyTo}` }) }}</span>
      <ChevronRight :size="14" aria-hidden="true" class="ml-auto shrink-0 transition-transform group-open/mail:rotate-90" />
    </summary>
    <div class="px-3 pb-2">
      <div v-if="mail.subject" class="mt-1 text-sm font-semibold wrap-break-word text-gray-900">{{ mail.subject }}</div>
      <div v-if="body" class="mt-1 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-gray-800">{{ body }}</div>
      <MessageTools v-if="timestamp && body" :content="body" :timestamp="timestamp" />
    </div>
  </details>
</template>
