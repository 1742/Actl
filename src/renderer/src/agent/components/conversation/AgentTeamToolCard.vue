<script setup lang="ts">
import { reactive } from 'vue';
import { Check, ChevronRight, Circle, CircleDot } from '@lucide/vue';
import type { AgentTeamCard } from '../../utils/toolCatalog/agentTeamCards';
import MessageHtml from '../responses/MessageHtml.vue';
import AgentCardDetails from './AgentCardDetails.vue';

defineProps<{ card: AgentTeamCard; embedded?: boolean }>();
const expandedMail = reactive(new Set<string>());

function toggleMail(key: string) {
  if (expandedMail.has(key)) expandedMail.delete(key);
  else expandedMail.add(key);
}

const tones = {
  neutral: 'bg-gray-100 text-gray-600',
  active: 'bg-primary/10 text-primary',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
};
</script>

<template>
  <div class="max-h-88 min-w-0 overflow-auto text-sm leading-5" :class="{ 'rounded-lg border border-gray-200 bg-white': !embedded }">
    <p v-if="card.empty" class="px-3 py-2.5 text-gray-500">{{ card.empty }}</p>
    <ul v-else-if="card.kind === 'mail_search'" class="divide-y divide-gray-100">
      <li v-for="row in card.rows" :key="row.reference || row.title">
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-gray-50"
          :aria-expanded="expandedMail.has(row.reference || row.title)"
          @click="toggleMail(row.reference || row.title)"
        >
          <ChevronRight :size="14" class="shrink-0 text-gray-400 transition-transform"
            :class="{ 'rotate-90': expandedMail.has(row.reference || row.title) }" aria-hidden="true" />
          <span v-if="row.reference" class="shrink-0 font-mono text-xs text-gray-500">{{ row.reference }}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium text-gray-900" :title="row.title">{{ row.title }}</span>
            <span v-if="row.detail" class="block truncate text-xs text-gray-500">{{ row.detail }}</span>
          </span>
          <span v-if="row.status" class="shrink-0 rounded-full px-2 text-xs" :class="tones[row.status.tone]">{{ row.status.text }}</span>
        </button>
        <div v-if="row.body && expandedMail.has(row.reference || row.title)" class="min-w-0 border-t border-gray-100 px-3 py-2">
          <MessageHtml :html-string="row.body" :is-invert="false" />
        </div>
      </li>
    </ul>
    <ul v-else :class="{ 'divide-y divide-gray-100': !embedded }">
      <li v-for="(row, index) in card.rows" :key="index" class="flex min-w-0 gap-2.5 px-3" :class="embedded ? 'py-2' : 'py-2.5'">
        <span v-if="card.kind === 'plan'" class="flex h-5 shrink-0 items-center">
          <Check v-if="row.status?.tone === 'success'" :size="14" class="text-emerald-600" aria-hidden="true" />
          <CircleDot v-else-if="row.status?.tone === 'active'" :size="14" class="text-primary" aria-hidden="true" />
          <Circle v-else :size="14" class="text-gray-400" aria-hidden="true" />
          <span class="sr-only">{{ row.status?.text || $t('agentToolCards.planPending') }}</span>
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              v-if="row.reference"
              class="max-w-full wrap-anywhere rounded bg-gray-100 px-1.5 font-mono text-[13px] text-gray-500"
            >{{ row.reference }}</span>
            <p class="min-w-0 wrap-anywhere font-medium text-gray-900">{{ row.title }}</p>
            <span
              v-if="card.kind !== 'plan' && row.status"
              class="rounded-full px-2 text-[13px] font-medium"
              :class="tones[row.status.tone]"
            >{{ row.status.text }}</span>
          </div>
          <p v-if="row.detail" class="wrap-anywhere text-gray-500">{{ row.detail }}</p>
          <AgentCardDetails :body="row.body" :fields="row.fields" />
          <details v-if="row.result" class="mt-2 border-t border-gray-100 pt-1.5">
            <summary class="cursor-pointer font-medium text-gray-700">{{ $t('agentToolCards.result') }}</summary>
            <p class="mt-1 whitespace-pre-wrap wrap-anywhere text-gray-700">{{ row.result }}</p>
          </details>
        </div>
      </li>
    </ul>
  </div>
</template>
