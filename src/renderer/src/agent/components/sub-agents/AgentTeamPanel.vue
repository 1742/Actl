<script setup lang="ts">
import { computed, inject } from 'vue';
import type { AgentTask } from '../../../../../shared/agent/coordination';
import { agentTreeKey } from '../../composables/useAgentTree';

const team = inject(agentTreeKey);
const items = computed(() => team?.tree.value?.plan.items ?? []);
const tasks = computed(() => team?.tree.value?.tasks ?? []);
const taskTitles = computed(() => new Map(tasks.value.map(({ id, title }) => [id, title])));
const memberTitles = computed(() => new Map(team?.tree.value?.members.map(({ session }) => [session.id, session.title])));
const error = computed(() => team?.error.value);

function taskStatus(task: AgentTask) {
  if (task.status === 'completed') return 'agents.taskStatus.completed';
  if (task.status === 'in_progress') return 'agents.taskStatus.inProgress';
  return task.ready ? 'agents.taskStatus.ready' : 'agents.taskStatus.blocked';
}
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
  <details v-if="tasks.length" class="mb-3 rounded-lg border border-current/10 px-3 py-2 text-sm" open>
    <summary class="cursor-pointer select-none">{{ $t('agents.tasks') }}</summary>
    <ul class="mt-1 divide-y divide-current/10">
      <li v-for="task in tasks" :key="task.id" class="py-2">
        <details>
          <summary class="cursor-pointer wrap-break-word" :title="task.id">
            {{ task.title }}
            <span class="ml-1 text-xs" :class="task.ready ? 'text-primary' : 'text-gray-500'">{{ $t(taskStatus(task)) }}</span>
          </summary>
          <p class="mt-2 whitespace-pre-wrap wrap-break-word text-xs">{{ task.instructions }}</p>
          <p class="mt-2 whitespace-pre-wrap wrap-break-word text-xs">{{ $t('agents.acceptanceCriteria') }} · {{ task.acceptanceCriteria }}</p>
        </details>
        <p v-if="task.ownerSessionId" class="mt-1 ml-3 wrap-break-word text-xs text-gray-500">
          {{ $t('agents.taskOwner') }} · {{ task.ownerSessionId === team?.rootId.value ? $t('agents.parentAgent') : memberTitles.get(task.ownerSessionId) || task.ownerSessionId }}
        </p>
        <p v-if="task.blockedBy.length" class="mt-1 ml-3 wrap-break-word text-xs text-gray-500">
          {{ $t('agents.taskDependencies') }} · {{ task.blockedBy.map((id) => taskTitles.get(id) ?? id).join(', ') }}
        </p>
      </li>
    </ul>
  </details>
</template>
