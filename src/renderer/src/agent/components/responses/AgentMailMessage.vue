<script setup lang="ts">
import { computed } from 'vue';
import { ChevronRight, Mail } from '@lucide/vue';
import { readContentText } from '../../utils/aiResponse';
import MessageTools from './MessageTools.vue';
import MessageAuthor from './MessageAuthor.vue';
import MessageHtml from './MessageHtml.vue';
import type { AgentMailMessageItem } from './types';

const props = defineProps<{
  item: AgentMailMessageItem;
  timestamp?: string;
  compact?: boolean;
}>();
const body = computed(() => readContentText(props.item.content));
const mail = computed(() => props.item.source);
</script>

<template>
  <details class="group/mail group/message min-w-0 max-w-full" :class="{ 'rounded-lg border border-gray-200 bg-gray-50/60': !compact }">
    <summary
      class="group/summary flex max-w-full cursor-pointer list-none items-center text-gray-500"
      :class="compact
        ? 'h-6 w-fit gap-1.5 whitespace-nowrap text-[15px] hover:text-gray-700'
        : 'flex-wrap gap-x-2 gap-y-1 rounded-lg px-3 py-2 text-xs hover:bg-gray-100'"
    >
      <div class="inline-flex min-w-0 max-w-full items-center gap-1.5">
        <Mail :size="14" class="shrink-0" aria-hidden="true" />
        <MessageAuthor :item="item" :class="{ 'text-[15px]! text-inherit!': compact }" />
      </div>
      <span :class="{ 'font-medium text-amber-700': mail.purpose === 'urgent' }">
        {{ $t(`agents.messagePurpose.${mail.purpose}`) }}
      </span>
      <span class="tabular-nums" :class="{ 'text-sm': compact }">m#{{ mail.mailNumber }}</span>
      <span v-if="mail.replyTo != null" :class="{ 'truncate text-sm': compact }">{{ $t('agents.inReplyTo', { message: `m#${mail.replyTo}` }) }}</span>
      <ChevronRight :size="14" aria-hidden="true" class="shrink-0 transition-transform group-open/mail:rotate-90" :class="compact ? 'text-gray-400 group-hover/summary:text-gray-600' : 'ml-auto'" />
    </summary>
    <div
      v-if="mail.subject || body"
      class="min-w-0 space-y-1 bg-white px-3 py-2"
      :class="compact ? 'mt-2 rounded-lg border border-gray-200' : 'rounded-b-lg border-t border-gray-200'"
    >
      <div v-if="mail.subject" class="text-sm font-semibold wrap-break-word text-gray-900">{{ mail.subject }}</div>
      <MessageHtml v-if="body" :html-string="body" :is-invert="false" />
      <MessageTools v-if="timestamp && body" :content="body" :timestamp="timestamp" />
    </div>
  </details>
</template>
