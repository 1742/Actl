<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { LoaderCircle } from '@lucide/vue';
import type { RuntimeSession } from '../navigation/types';
import { agentTreeKey } from '../../composables/useAgentTree.ts';
import { loadSubagentHistory } from '../../composables/useAgent.ts';
import { desktopRequest } from '../../services/desktopTransport.ts';
import { useAgentStore } from '../../stores/agent.ts';
import MessagesArea from '../conversation/MessagesArea.vue';
import AgentTeamPanel from './AgentTeamPanel.vue';

const props = defineProps<{ visible: boolean; subagent?: RuntimeSession | undefined }>();
defineEmits<{ openSubagent: [session: RuntimeSession] }>();
const team = inject(agentTreeKey)!;
const store = useAgentStore();
const error = ref('');
const members = computed(() => Object.values(team.tree.value?.members ?? {}).filter(
  ({ session }) => session.parentSessionId === team.rootId.value,
));
const selectedKey = computed(() => props.subagent?.id ?? '');
const active = computed(() => Object.values(team.tree.value?.members ?? {}).some(({ session, waiting }) => waiting || store.sessionIsActive(session.id)));
const selectedWaiting = computed(() => members.value.some(({ session, waiting }) => session.id === selectedKey.value && waiting));

watch(team.rootId, () => {
  error.value = '';
}, { flush: 'sync' });

watch([selectedKey, () => props.visible], ([id, visible], _, onCleanup) => {
  if (!id || !visible) return;
  let current = true;
  onCleanup(() => { current = false; });
  void loadSubagentHistory(id, () => current && selectedKey.value === id && props.visible);
}, { immediate: true });

function runStatusLabel(status?: string) {
  if (status === 'cancelled') return 'agents.cancelled';
  if (status === 'failed' || status === 'incomplete') return 'agents.failed';
  return 'agents.done';
}

async function stop(id: string) {
  const root = team.rootId.value;
  error.value = '';
  try { await desktopRequest({ operation: 'agents.stop', params: { sessionId: id } }); }
  catch (reason) { if (team.rootId.value === root) error.value = String(reason); }
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" :aria-label="$t('agents.subagents')">
    <header v-if="subagent" class="flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-gray-700">
      <h2
        class="mr-auto min-w-0 truncate rounded-full border border-gray-200 bg-white px-3 py-1.5 shadow-sm"
        :title="subagent.title || subagent.id"
      >
        {{ subagent.title || subagent.id }}
      </h2>
      <span v-if="subagent.profile" class="max-w-[40%] truncate text-xs text-gray-500" :title="subagent.profile.name">
        {{ subagent.profile.name }}
      </span>
      <button
        v-if="selectedWaiting || store.sessionIsActive(selectedKey)"
        class="h-8 shrink-0 rounded-full border border-gray-200 bg-white px-3 text-xs shadow-sm transition-colors hover:bg-gray-100"
        type="button"
        @click="stop(subagent.runtimeId)"
      >
        {{ $t('agents.stop') }}
      </button>
    </header>
    <p v-if="error" class="px-3 py-2 text-sm text-red-600" role="alert">{{ error }}</p>
    <MessagesArea v-if="subagent" :session-id="selectedKey" :bottom-inset="0" compact runs-only />
    <div v-else class="min-h-0 flex-1 overflow-y-auto p-3">
      <AgentTeamPanel />
      <div class="mb-2 flex items-center justify-between gap-2">
        <button v-if="active && team.rootId.value" class="rounded px-2 py-1 text-xs hover:bg-gray-100" type="button" @click="stop(team.rootId.value)">
          {{ $t('agents.stopAll') }}
        </button>
      </div>
      <p v-if="!members.length" class="py-2 text-sm text-gray-500">{{ $t('agents.empty') }}</p>
      <ul v-else class="space-y-1">
        <li v-for="{ session, runtime, waiting } in members" :key="session.id" class="flex min-w-0 items-center rounded-lg hover:bg-gray-100">
          <button class="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm" type="button" @click="$emit('openSubagent', session)">
            <span class="min-w-0 flex-1">
              <span class="block truncate">{{ session.title || session.runtimeId }}</span>
              <span v-if="session.profile" class="block truncate text-xs text-gray-500">{{ session.profile.name }}</span>
            </span>
            <span v-if="runtime.status === 'waiting_permission'" class="shrink-0 rounded bg-amber-100 px-1.5 text-xs text-amber-800">
              {{ $t('agents.approval') }}
            </span>
            <span v-else-if="waiting" class="shrink-0 text-xs text-gray-500">{{ $t('agents.waiting') }}</span>
            <LoaderCircle v-else-if="store.sessionIsActive(session.id)" :size="14" class="shrink-0 animate-spin text-primary"
              :aria-label="$t(runtime.status === 'stopping' ? 'agents.stopping' : 'ui.sessionRunning')" />
            <span v-else-if="runtime.responses.length" class="shrink-0 text-xs text-gray-500">
              {{ $t(runStatusLabel(runtime.responses.at(-1)?.response.status)) }}
            </span>
          </button>
          <button v-if="waiting || store.sessionIsActive(session.id)" class="shrink-0 rounded px-2 py-1 text-xs hover:bg-gray-200" type="button" @click="stop(session.runtimeId)">
            {{ $t('agents.stop') }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
