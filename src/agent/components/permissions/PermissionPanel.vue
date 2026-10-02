<script setup lang="ts">
import { tr } from '../../../i18n';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Square } from '@lucide/vue';
import { computed, ref, watch } from 'vue';

import { useNotifyStore } from '../../../composables/notify';
import { resolveAgentPermissionBatch, stopAgentResponse } from '../../composables/useAgent';
import { useAgentStore } from '../../stores/agent';
import type { PermissionDecision } from '../../types';

const agentStore = useAgentStore();
const notify = useNotifyStore();
const currentIndex = ref(0);
const previewExpanded = ref(false);
const decisions = ref<Record<string, PermissionDecision>>({});
const denialReasons = ref<Record<string, string>>({});
const batch = computed(() => agentStore.pendingPermissionBatch);
const permissions = computed(() => batch.value?.permissions || []);
const permission = computed(() => permissions.value[currentIndex.value]);
const currentDecision = computed(() =>
  permission.value ? decisions.value[permission.value.id] : undefined,
);
const currentDenialReason = computed({
  get: () => (permission.value ? denialReasons.value[permission.value.id] || '' : ''),
  set: (value: string) => {
    if (!permission.value) return;
    denialReasons.value = { ...denialReasons.value, [permission.value.id]: value };
    if (currentDecision.value?.decision === 'deny') {
      decisions.value = {
        ...decisions.value,
        [permission.value.id]: {
          permission_id: permission.value.id,
          decision: 'deny',
          reason: value.trim(),
        },
      };
    }
  },
});
const canDeny = computed(() => Boolean(currentDenialReason.value.trim()) && !agentStore.isRunning);
const shellCommand = computed(() => {
  if (permission.value?.tool_call.name !== 'shell') return '';
  const input = permission.value.tool_call.input;
  return input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
    ? input.command
    : '';
});
const workingDirectory = computed(() => {
  if (!shellCommand.value) return '';
  const resource = permission.value?.resource || permission.value?.requirement.resource;
  if (resource) {
    try {
      const parsed: unknown = JSON.parse(resource);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'cwd' in parsed &&
        typeof parsed.cwd === 'string'
      ) {
        return parsed.cwd;
      }
    } catch {
      /* The resource can be plain text for other permission providers. */
    }
  }
  const input = permission.value?.tool_call.input;
  return input && typeof input === 'object' && 'cwd' in input && typeof input.cwd === 'string'
    ? input.cwd
    : '';
});
const permissionTitle = computed(() =>
  shellCommand.value
    ? tr('ui.allowThisShellCommand')
    : tr('dynamic.permissionTool', { name: permission.value?.tool_call.name || tr('ui.thisTool') }),
);
const permissionPreview = computed(
  () =>
    shellCommand.value ||
    permission.value?.resource ||
    permission.value?.requirement.resource ||
    permission.value?.prompt ||
    '',
);
const toolParameters = computed(() => {
  const input = permission.value?.tool_call?.input;
  if (input === undefined) return '';
  const parameters =
    shellCommand.value && input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'command'))
      : input;
  if (parameters && typeof parameters === 'object' && !Object.keys(parameters).length) return '';
  try {
    return JSON.stringify(parameters, null, 2) ?? '';
  } catch {
    return String(input);
  }
});

watch(
  () => batch.value?.id,
  () => {
    currentIndex.value = 0;
    decisions.value = {};
    denialReasons.value = {};
  },
);
watch(
  () => permission.value?.id,
  () => {
    previewExpanded.value = false;
  },
);

function move(offset: number) {
  const next = currentIndex.value + offset;
  if (next >= 0 && next < permissions.value.length) currentIndex.value = next;
}

async function applyDecision(decision: PermissionDecision) {
  const sessionId = agentStore.selectedSessionId;
  const updated = { ...decisions.value, [decision.permission_id]: decision };
  decisions.value = updated;

  for (let offset = 1; offset < permissions.value.length; offset += 1) {
    const nextIndex = (currentIndex.value + offset) % permissions.value.length;
    if (!updated[permissions.value[nextIndex].id]) {
      currentIndex.value = nextIndex;
      return;
    }
  }

  const orderedDecisions = permissions.value.map((item) => updated[item.id]);
  const result = await resolveAgentPermissionBatch(orderedDecisions, sessionId);
  notify.display(result.status, result.message);
}

async function approve() {
  if (!permission.value || agentStore.isRunning) return;
  await applyDecision({ permission_id: permission.value.id, decision: 'approve' });
}

async function deny() {
  if (!permission.value || !canDeny.value) return;
  await applyDecision({
    permission_id: permission.value.id,
    decision: 'deny',
    reason: currentDenialReason.value.trim(),
  });
}

async function stop() {
  const result = await stopAgentResponse(agentStore.selectedSessionId);
  notify.display(result.status, result.message);
}
</script>

<template>
  <section
    v-if="batch && permission"
    class="max-h-[45dvh] w-full min-w-0 overflow-y-auto border-b border-gray-200 bg-white px-2 pt-4 sm:px-4"
  >
    <div class="flex items-start gap-3 px-2">
      <h2 class="min-w-0 flex-1 wrap-anywhere text-sm font-semibold leading-6 text-gray-950">
        {{ permissionTitle }}
      </h2>
      <div class="flex shrink-0 items-center gap-1">
        <button
          class="permission-nav-button w-auto gap-1 px-2 text-xs"
          type="button"
          :disabled="agentStore.isStopping"
          :title="$t('ui.stopGenerating')"
          @click="stop"
        >
          <Square :size="11" fill="currentColor" />
          {{ agentStore.isStopping ? $t('ui.stopping') : $t('ui.stop') }}
        </button>
        <div
          v-if="permissions.length > 1"
          class="flex items-center gap-1"
          :aria-label="$t('ui.switchPermissionRequests')"
        >
          <button
            class="permission-nav-button w-7"
            type="button"
            :title="$t('ui.previousPermissionRequest')"
            :aria-label="$t('ui.previousPermissionRequest')"
            :disabled="currentIndex === 0 || agentStore.isRunning"
            @click="move(-1)"
          >
            <ChevronLeft :size="15" />
          </button>
          <span class="min-w-10 text-center text-xs tabular-nums text-gray-500"
            >{{ currentIndex + 1 }} / {{ permissions.length }}</span
          >
          <button
            class="permission-nav-button w-7"
            type="button"
            :title="$t('ui.nextPermissionRequest')"
            :aria-label="$t('ui.nextPermissionRequest')"
            :disabled="currentIndex === permissions.length - 1 || agentStore.isRunning"
            @click="move(1)"
          >
            <ChevronRight :size="15" />
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="workingDirectory"
      class="mt-2 flex min-w-0 items-baseline gap-2 px-2 text-xs text-gray-500"
    >
      <span class="shrink-0">{{ $t('ui.workingDirectory') }}</span>
      <span class="min-w-0 truncate font-mono text-gray-700" :title="workingDirectory">{{
        workingDirectory
      }}</span>
    </div>

    <div
      v-if="permissionPreview"
      class="mx-2 mt-3 min-w-0 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5"
    >
      <div class="mb-1 flex items-center justify-between gap-2">
        <p class="text-[11px] font-medium text-gray-500">
          {{ shellCommand ? $t('ui.commandPreview') : $t('ui.requestDetails') }}
        </p>
        <button
          class="flex shrink-0 items-center gap-1 text-xs text-gray-500 hover:text-gray-800"
          type="button"
          :aria-expanded="previewExpanded"
          @click="previewExpanded = !previewExpanded"
        >
          {{ previewExpanded ? $t('ui.collapse') : $t('ui.expand') }}
          <ChevronUp v-if="previewExpanded" :size="13" />
          <ChevronDown v-else :size="13" />
        </button>
      </div>
      <pre
        class="permission-preview font-mono text-xs leading-5 text-gray-800"
        :class="{ 'permission-preview-collapsed': !previewExpanded }"
        >{{ permissionPreview }}</pre>
      <div
        v-if="
          previewExpanded &&
          (toolParameters ||
            (!shellCommand && permission.prompt && permission.prompt !== permissionPreview))
        "
        class="mt-3 space-y-2 border-t border-gray-200 pt-2 text-xs text-gray-500"
      >
        <template v-if="toolParameters">
          <p class="font-medium">
            {{ shellCommand ? $t('ui.otherArguments') : $t('ui.toolArguments') }}
          </p>
          <pre
            class="whitespace-pre-wrap wrap-anywhere font-mono text-[11px] leading-5 text-gray-700"
            >{{ toolParameters }}</pre>
        </template>
        <p
          v-if="!shellCommand && permission.prompt && permission.prompt !== permissionPreview"
          class="wrap-anywhere text-gray-700"
        >
          {{ permission.prompt }}
        </p>
      </div>
    </div>

    <div class="sticky bottom-0 z-10 mt-4 space-y-2 bg-white pb-2 pt-2">
      <button
        class="choice-row"
        :class="{ 'choice-row-selected': currentDecision?.decision === 'approve' }"
        type="button"
        :disabled="agentStore.isRunning"
        @click="approve"
      >
        <span class="choice-number">1</span>
        <span class="min-w-0 flex-1 text-left">{{
          currentDecision?.decision === 'approve' ? $t('ui.allowSelected') : $t('ui.allow')
        }}</span>
      </button>
      <div class="flex items-center gap-2">
        <span class="choice-number ml-2">2</span>
        <input
          v-model="currentDenialReason"
          class="min-w-0 flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none placeholder:text-gray-400 focus:border-primary focus:ring-2 focus:ring-primary/10"
          :placeholder="$t('ui.enterAReasonForDenialAnd')"
          :disabled="agentStore.isRunning"
          @keydown.enter.prevent="deny"
        />
        <button
          class="shrink-0 rounded-full px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
          :class="
            currentDecision?.decision === 'deny'
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-primary text-primary-fg hover:bg-primary-hover'
          "
          type="button"
          :disabled="!canDeny"
          @click="deny"
        >
          {{ currentDecision?.decision === 'deny' ? $t('ui.denySelected') : $t('ui.deny') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";
.permission-nav-button {
  @apply flex h-7 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent;
}
.choice-row {
  @apply flex w-full items-center gap-2 rounded-xl px-2 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50;
  color: var(--color-primary-fg);
  background-color: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.choice-row:hover,
.choice-row-selected {
  background-color: color-mix(in srgb, var(--color-primary) 17%, transparent);
}
.choice-number {
  @apply flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs text-gray-500;
}
.choice-row .choice-number {
  color: var(--color-primary-fg);
  background-color: var(--color-primary);
}
.permission-preview {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.permission-preview-collapsed {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}
</style>
