<script setup lang="ts">
import { computed, inject } from 'vue';
import { agentTreeKey } from '../../composables/useAgentTree';

const team = inject(agentTreeKey);
const items = computed(() => team?.tree.value?.plan.items ?? []);
const error = computed(() => team?.error.value);
</script>

<template>
  <details v-if="items.length || error" class="mb-3 rounded-lg border border-current/10 px-3 py-2 text-sm" open>
    <summary class="cursor-pointer select-none">{{ $t('agents.plan') }}</summary>
    <ul class="mt-2 max-h-36 space-y-1 overflow-auto">
      <li v-for="item in items" :key="item.id" :class="{ 'line-through opacity-50': item.status === 'completed' }">
        <span :aria-label="item.status">{{ item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◉' : '○' }}</span> {{ item.text }}
      </li>
    </ul>
    <p v-if="error" role="alert" class="mt-2 text-red-500">{{ error }}</p>
  </details>
</template>
