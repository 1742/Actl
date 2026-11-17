<script setup lang="ts">
import { Check, Circle, CircleDot } from '@lucide/vue';
import type { AgentTeamCard } from '../../utils/agentTeamCards';

defineProps<{ card: AgentTeamCard }>();

const tones = {
  neutral: 'bg-gray-100 text-gray-600',
  active: 'bg-primary/10 text-primary',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
};
</script>

<template>
  <div class="max-h-88 min-w-0 overflow-auto rounded-lg border border-gray-200 bg-white text-xs leading-5">
    <p v-if="card.empty" class="px-3 py-2.5 text-gray-500">{{ card.empty }}</p>
    <ul v-else class="divide-y divide-gray-100">
      <li v-for="(row, index) in card.rows" :key="index" class="flex min-w-0 gap-2.5 px-3 py-2.5">
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
              class="max-w-full wrap-anywhere rounded bg-gray-100 px-1.5 font-mono text-[11px] text-gray-500"
            >{{ row.reference }}</span>
            <p class="min-w-0 wrap-anywhere font-medium text-gray-900">{{ row.title }}</p>
            <span
              v-if="card.kind !== 'plan' && row.status"
              class="rounded-full px-2 text-[11px] font-medium"
              :class="tones[row.status.tone]"
            >{{ row.status.text }}</span>
          </div>
          <p v-if="row.detail" class="wrap-anywhere text-gray-500">{{ row.detail }}</p>
          <p v-if="row.body" class="mt-1 whitespace-pre-wrap wrap-anywhere text-gray-700">{{ row.body }}</p>
          <dl v-if="row.fields?.some(({ value }) => value)" class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
            <template v-for="{ label, value } in row.fields" :key="label">
              <dt v-if="value" class="text-gray-500">{{ label }}</dt>
              <dd v-if="value" class="whitespace-pre-wrap wrap-anywhere text-gray-700">{{ value }}</dd>
            </template>
          </dl>
          <details v-if="row.result" class="mt-2 border-t border-gray-100 pt-1.5">
            <summary class="cursor-pointer font-medium text-gray-700">{{ $t('agentToolCards.result') }}</summary>
            <p class="mt-1 whitespace-pre-wrap wrap-anywhere text-gray-700">{{ row.result }}</p>
          </details>
        </div>
      </li>
    </ul>
  </div>
</template>
