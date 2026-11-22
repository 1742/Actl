<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowUpRight } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { openAgentSubagent } from '../../router';
import { useAgentStore, type TreePermissionRequest } from '../../stores/agent';
import PermissionPanel from './PermissionPanel.vue';

const store = useAgentStore();
const router = useRouter();
const selectedKey = ref('');
const requests = computed(() => store.permissionRequests);
const selected = computed(() => requests.value.find((request) => key(request) === selectedKey.value) ?? requests.value[0]);

function key(request: TreePermissionRequest) {
  return `${request.sessionId}:${request.responseId}:${request.batchId}`;
}
</script>

<template>
  <div v-if="selected" class="w-full min-w-0" :aria-label="$t('agents.approvals')">
    <div v-if="selected.session.parentSessionId || requests.length > 1"
      class="flex min-w-0 flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2">
      <button v-for="request in requests" :key="key(request)" type="button"
        class="min-w-0 max-w-full truncate rounded-full border px-2.5 py-1 text-xs"
        :class="key(request) === key(selected) ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 text-gray-600 hover:bg-gray-50'"
        :aria-pressed="key(request) === key(selected)"
        @click="selectedKey = key(request)">
        {{ request.session.parentSessionId ? request.session.title || request.session.runtimeId : $t('agents.parentAgent') }}
        <template v-if="request.task"> · #{{ request.task.number }} {{ request.task.title }}</template>
      </button>
      <button v-if="selected.session.parentSessionId" type="button"
        class="ml-auto flex shrink-0 items-center gap-1 px-1 py-1 text-xs text-gray-600 hover:text-gray-900"
        @click="openAgentSubagent(router, selected.sessionId)">
        {{ $t('agents.openConversation') }} <ArrowUpRight :size="13" />
      </button>
    </div>
    <PermissionPanel v-for="request in requests" v-show="key(request) === key(selected)"
      :key="key(request)" :request="request" />
  </div>
</template>
