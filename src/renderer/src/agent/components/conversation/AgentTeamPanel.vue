<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { tr } from '../../../i18n';
import { useAgentStore } from '../../stores/agent';
import { applyAgentTreeSnapshot, applyRuntimeEvent, runtimeResourceKey, selectAgentSession } from '../../composables/useAgent';
import { desktopRequest, unwrap } from '../../services/desktopTransport';
import type { AgentTreeSnapshot } from '../../../../../shared/agent/coordination';

const store = useAgentStore();
const tree = ref<AgentTreeSnapshot>();
const error = ref('');
const followup = ref('');
const targetId = ref('');
const sending = ref(false);
const rootId = computed(() => store.session?.rootSessionId ?? store.session?.runtimeId);
const children = computed(() => tree.value?.members.filter((item) => item.session.parentSessionId) ?? []);
const active = computed(() => tree.value?.members.some((item) => {
  const status = store.runtimeBySessionId[runtimeResourceKey('local', item.session.id)]?.status;
  return status === 'running' || status === 'waiting_permission' || status === 'stopping';
}));
let cleanup: (() => void) | undefined;

watch(rootId, (root) => {
  cleanup?.(); tree.value = undefined; error.value = ''; targetId.value = '';
  if (!root || !window.actlAgent?.watchTree) return;
  const id = crypto.randomUUID();
  let disposed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const accept = (snapshot: AgentTreeSnapshot) => {
    if (disposed || snapshot.rootSessionId !== root) return;
    tree.value = snapshot;
    applyAgentTreeSnapshot(snapshot);
  };
  const refresh = () => {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void desktopRequest<AgentTreeSnapshot>({ operation: 'agents.tree', params: { sessionId: root } })
        .then(accept).catch((reason: unknown) => { if (!disposed) error.value = String(reason); });
    }, 50);
  };
  const off = window.actlAgent.onTreeEvents((batch) => {
    if (disposed || batch.subscriptionId !== id) return;
    const event = batch.event;
    if (event.type === 'snapshot') accept(event.snapshot);
    else if (event.type === 'changed') refresh();
    else {
      const sessionId = runtimeResourceKey('local', event.sessionId);
      for (const responseEvent of event.events) applyRuntimeEvent(sessionId, responseEvent);
    }
  });
  cleanup = () => { disposed = true; off(); if (refreshTimer) clearTimeout(refreshTimer); window.actlAgent.detach(id); };
  void window.actlAgent.watchTree(id, root).then(unwrap).catch((reason: unknown) => { if (!disposed) error.value = String(reason); });
}, { immediate: true });
onUnmounted(() => cleanup?.());

function statusLabel(id: string): string {
  const status = store.runtimeBySessionId[runtimeResourceKey('local', id)]?.status;
  const response = tree.value?.members.find((item) => item.session.id === id)?.response;
  if (status === 'running') return tr('agents.running');
  if (status === 'waiting_permission') return tr('agents.approval');
  if (status === 'stopping') return tr('agents.stopping');
  if (response?.status === 'failed' || response?.status === 'incomplete') return tr('agents.failed');
  if (response?.status === 'cancelled') return tr('agents.cancelled');
  return tr('agents.done');
}
async function stop(id: string) {
  try { await desktopRequest({ operation: 'agents.stop', params: { sessionId: id } }); }
  catch (reason) { error.value = String(reason); }
}
async function send() {
  if (!rootId.value || !targetId.value || !followup.value.trim() || sending.value) return;
  sending.value = true; error.value = '';
  try {
    await desktopRequest({ operation: 'agents.message', params: { sessionId: rootId.value },
      body: { targetSessionId: targetId.value, message: followup.value } });
    followup.value = ''; targetId.value = '';
  } catch (reason) { error.value = String(reason); }
  finally { sending.value = false; }
}
</script>

<template>
  <details v-if="children.length || tree?.plan.items.length || error" class="mx-4 mb-2 rounded-lg border border-current/10 px-3 py-2 text-sm" open>
    <summary class="cursor-pointer select-none">{{ tr('agents.team') }} · {{ children.length }}
      <span class="ml-2 opacity-60">{{ tr('agents.readOnly') }}</span>
    </summary>
    <div class="mt-2 flex flex-wrap items-center gap-2">
      <button v-if="store.session?.parentSessionId && rootId" class="rounded px-2 py-1 hover:bg-current/10" @click="selectAgentSession(runtimeResourceKey('local', rootId))">{{ tr('agents.back') }}</button>
      <button v-if="active && rootId" class="rounded px-2 py-1 hover:bg-current/10" @click="stop(rootId)">{{ tr('agents.stopAll') }}</button>
    </div>
    <ul class="max-h-48 space-y-1 overflow-auto">
      <li v-for="member in children" :key="member.session.id" class="flex flex-wrap items-center gap-2">
        <button class="min-w-0 truncate rounded px-2 py-1 hover:bg-current/10" @click="selectAgentSession(runtimeResourceKey('local', member.session.id))">{{ member.session.title || member.session.id }}</button>
        <span class="opacity-70">{{ statusLabel(member.session.id) }}</span>
        <button class="rounded px-2 py-1 hover:bg-current/10" @click="targetId = member.session.id">{{ tr('agents.followup') }}</button>
        <button v-if="store.sessionIsActive(runtimeResourceKey('local', member.session.id))" class="rounded px-2 py-1 hover:bg-current/10" @click="stop(member.session.id)">{{ tr('agents.stop') }}</button>
      </li>
    </ul>
    <form v-if="targetId" class="mt-2 flex gap-2" @submit.prevent="send">
      <input v-model="followup" :aria-label="tr('agents.followup')" :placeholder="tr('agents.followupHint')" maxlength="16000" class="min-w-0 flex-1 rounded border border-current/20 bg-transparent px-2 py-1" />
      <button type="submit" :disabled="sending || !followup.trim()" class="rounded px-2 py-1 hover:bg-current/10 disabled:opacity-40">{{ tr('agents.send') }}</button>
    </form>
    <ul v-if="tree?.plan.items.length" class="mt-2 max-h-36 space-y-1 overflow-auto border-t border-current/10 pt-2">
      <li v-for="item in tree.plan.items" :key="item.id" :class="{ 'line-through opacity-50': item.status === 'completed' }">
        <span :aria-label="item.status">{{ item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◉' : '○' }}</span> {{ item.text }}
      </li>
    </ul>
    <p v-if="error" role="alert" class="mt-2 text-red-500">{{ error }}</p>
  </details>
</template>
