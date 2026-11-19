<script setup lang="ts">
import { computed, inject } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { tr } from '../../../i18n';
import type { AgentTask } from '../../../../../shared/agent/coordination';
import { agentTreeKey } from '../../composables/useAgentTree';
import { planCardRows } from '../../utils/toolCatalog/agentTeamCards';
import AgentTeamToolCard from '../conversation/AgentTeamToolCard.vue';
import AgentCardDetails from '../conversation/AgentCardDetails.vue';

const team = inject(agentTreeKey);
const planRows = computed(() => planCardRows(team?.tree.value?.plan.items ?? []));
const tasks = computed(() => team?.tree.value?.tasks ?? []);
const taskTitles = computed(() => new Map(tasks.value.map(({ id, title }) => [id, title])));
const memberTitles = computed(() => new Map(Object.values(team?.tree.value?.members ?? {})
  .map(({ session }) => [session.runtimeId, session.title])));
const error = computed(() => team?.error.value);

const statusColors = {
  ready: 'bg-sky-50 text-sky-700',
  blocked: 'bg-amber-50 text-amber-800',
  no_idle_agent: 'bg-amber-50 text-amber-800',
  assigned: 'bg-indigo-50 text-indigo-700',
  running: 'bg-blue-50 text-blue-700',
  review_required: 'bg-violet-50 text-violet-700',
  completed: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-red-50 text-red-700',
  cancelled: 'bg-gray-100 text-gray-600',
};

function taskStatus(task: AgentTask) {
  if (task.status === 'pending') {
    if (task.pendingReason === 'no_idle_agent') return 'no_idle_agent';
    return task.ready ? 'ready' : 'blocked';
  }
  return task.status;
}

function taskOwner(task: AgentTask) {
  const id = task.attempt?.ownerSessionId;
  if (!id) return '';
  return id === team?.rootId.value ? tr('agents.parentAgent') : memberTitles.value.get(id) || id;
}
</script>

<template>
  <details v-if="planRows.length || error" class="mb-3 min-w-0 rounded-lg border border-gray-200 bg-white text-sm" open>
    <summary class="cursor-pointer select-none px-3 py-2">{{ $t('agents.plan') }}</summary>
    <AgentTeamToolCard v-if="planRows.length" embedded :card="{ kind: 'plan', rows: planRows }" />
    <p v-if="error" role="alert" class="px-3 pb-2 text-red-500">{{ error }}</p>
  </details>
  <details v-if="tasks.length" class="mb-3 min-w-0 rounded-lg border border-current/10 text-sm" open>
    <summary class="cursor-pointer select-none px-3 py-2">{{ $t('agents.tasks') }}</summary>
    <ul class="divide-y divide-current/10">
      <li v-for="task in tasks" :key="task.id" class="min-w-0 px-3 py-2">
        <details class="group/task">
          <summary class="flex min-w-0 cursor-pointer list-none items-center gap-2">
            <ChevronRight :size="12" aria-hidden="true" class="shrink-0 transition-transform group-open/task:rotate-90" />
            <span class="min-w-0 flex-1 truncate" :title="task.title"><span class="text-gray-500">#{{ task.number }}</span> {{ task.title }}</span>
            <span v-if="task.attempt" class="max-w-[28%] truncate text-xs text-gray-500" :title="taskOwner(task)">
              <span class="sr-only">{{ $t('agents.taskOwner') }} </span>{{ taskOwner(task) }}
            </span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium" :class="statusColors[taskStatus(task)]">{{ $t(`agents.taskStatus.${taskStatus(task)}`) }}</span>
          </summary>
          <div class="mt-2 text-sm leading-5">
            <AgentCardDetails
              :body="task.instructions !== task.title ? task.instructions : ''"
              :fields="[
                { label: $t('agents.taskOwner'), value: taskOwner(task) },
                { label: $t('agents.taskDependencies'), value: task.blockedBy.map((id) => taskTitles.get(id) ?? id).join(', ') },
                { label: $t('agents.acceptanceCriteria'), value: task.acceptanceCriteria },
                { label: $t('agentToolCards.reason'), value: task.attempt?.reason || '' },
              ]"
            />
          </div>
        </details>
      </li>
    </ul>
  </details>
</template>
