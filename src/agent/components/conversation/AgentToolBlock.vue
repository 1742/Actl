<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref } from 'vue';
import { ChevronRight } from '@lucide/vue';
import type { AgentToolTimelineBlock } from '../../types';
import AgentWebSearchBlock from './AgentWebSearchBlock.vue';

const props = defineProps<{ block: AgentToolTimelineBlock }>();

const labels: Record<AgentToolTimelineBlock['presentation'], string> = {
  shell: 'Shell',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  list: 'List',
  glob: 'Glob',
  grep: 'Grep',
  move: 'Move',
  delete: 'Delete',
  process: 'Process',
  skill: 'Skill',
  web: 'Search',
  generic: 'Tool',
};

const args = computed(() => props.block.arguments || {});
const output = computed(() => props.block.result?.output);
const outputRecord = computed(() => asRecord(output.value));
const expanded = ref(false);

const title = computed(() => labels[props.block.presentation]);
const path = computed(() => stringAt(args.value, 'path'));
const command = computed(() => stringAt(args.value, 'command'));
const summary = computed(() => {
  if (props.block.presentation === 'shell')
    return command.value || stringAt(args.value, 'processId');
  if (
    props.block.presentation === 'read' ||
    props.block.presentation === 'write' ||
    props.block.presentation === 'delete'
  ) {
    return path.value || stringAt(args.value, 'file_id');
  }
  if (props.block.presentation === 'glob') return stringAt(args.value, 'pattern');
  if (props.block.presentation === 'grep') {
    return [stringAt(args.value, 'pattern'), stringAt(args.value, 'path')]
      .filter(Boolean)
      .join(' in ');
  }
  if (props.block.presentation === 'list') return path.value || '.';
  if (props.block.presentation === 'move') {
    return [stringAt(args.value, 'source'), stringAt(args.value, 'destination')]
      .filter(Boolean)
      .join(' → ');
  }
  if (props.block.presentation === 'edit') {
    const patches = arrayAt(args.value, 'patches');
    return patches
      .map((patch) => stringAt(asRecord(patch), 'path'))
      .filter(Boolean)
      .join(', ');
  }
  if (props.block.presentation === 'process')
    return stringAt(args.value, 'processId') || command.value;
  if (props.block.presentation === 'skill')
    return stringAt(args.value, 'path') || stringAt(args.value, 'skillId');
  if (props.block.presentation === 'web') return stringAt(args.value, 'query');
  return props.block.call.name || 'tool';
});

const readContent = computed(() => stringAt(outputRecord.value, 'content'));
const writeContent = computed(() => stringAt(args.value, 'content'));
const shellStdout = computed(() => stringAt(outputRecord.value, 'stdout'));
const shellStderr = computed(() => stringAt(outputRecord.value, 'stderr'));
const shellOutput = computed(() => {
  const chunks = arrayAt(outputRecord.value, 'output');
  if (chunks.length) return chunks.map((chunk) => stringAt(asRecord(chunk), 'text')).join('');
  return [shellStdout.value, shellStderr.value].filter(Boolean).join('\n');
});
const patches = computed(() =>
  arrayAt(args.value, 'patches')
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item)),
);
const detailText = computed(() => formatUnknown(output.value));
const rawArguments = computed(() =>
  props.block.call.arguments ? prettyJson(props.block.call.arguments) : '',
);
const resultCount = computed(() => {
  const candidates = ['entries', 'files', 'data', 'matches'];
  for (const key of candidates) {
    const value = outputRecord.value?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
});
const hasDetails = computed(() =>
  Boolean(
    props.block.result?.error ||
    command.value ||
    readContent.value ||
    writeContent.value ||
    shellOutput.value ||
    patches.value.length ||
    detailText.value ||
    rawArguments.value,
  ),
);
const meta = computed(() => {
  if (props.block.status === 'waiting_permission') return tr('ui.awaitingPermission');
  if (props.block.status === 'preparing') return tr('ui.preparingArguments');
  if (props.block.status === 'running') return tr('ui.runningEllipsis');
  if (props.block.status === 'incomplete') return tr('ui.incomplete');
  if (props.block.status === 'error')
    return (
      props.block.result?.error || props.block.permission?.denial_reason || tr('ui.executionFailed')
    );
  if (props.block.presentation === 'write' && writeContent.value)
    return `${lineCount(writeContent.value)} lines`;
  if (props.block.presentation === 'read' && outputRecord.value) {
    const start = numberAt(outputRecord.value, 'startLine');
    const end = numberAt(outputRecord.value, 'endLine');
    if (start !== undefined && end !== undefined) return `Lines ${start}–${end}`;
  }
  if (props.block.presentation === 'shell' && outputRecord.value) {
    if (stringAt(outputRecord.value, 'status') === 'running') return tr('ui.runningInBackground');
    const exitCode = numberAt(outputRecord.value, 'exitCode');
    return exitCode === undefined ? tr('ui.completed') : `Exit code ${exitCode}`;
  }
  if (resultCount.value !== undefined) {
    if (props.block.presentation === 'glob') return `Found ${resultCount.value} files`;
    if (props.block.presentation === 'grep') return `${resultCount.value} matches`;
    if (props.block.presentation === 'list') return `${resultCount.value} entries`;
  }
  if (props.block.presentation === 'edit') {
    const changed = numberAt(outputRecord.value, 'filesChanged');
    if (changed !== undefined) return `${changed} files changed`;
  }
  return '';
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}

function numberAt(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function arrayAt(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

function lineCount(value: string) {
  return value ? value.split(/\r?\n/).length : 0;
}

function prettyJson(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatUnknown(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
</script>

<template>
  <AgentWebSearchBlock
    v-if="block.presentation === 'web'"
    :query="summary"
    :output="output"
    :status="block.status"
  />
  <div v-else class="min-w-0 text-[13px] text-gray-600">
    <button
      class="group flex max-w-full items-center gap-2 py-0.5 text-left"
      type="button"
      :disabled="!hasDetails"
      @click="expanded = !expanded"
    >
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="shrink-0 font-semibold text-gray-900">{{ title }}</span>
        <code v-if="summary" class="min-w-0 truncate font-mono text-[11px] text-gray-500">{{
          summary
        }}</code>
      </span>
      <ChevronRight
        v-if="hasDetails"
        :size="14"
        class="shrink-0 text-gray-400 transition-transform group-hover:text-gray-600"
        :class="{ 'rotate-90': expanded }"
      />
    </button>

    <div
      v-if="meta"
      class="mt-0.5 truncate text-xs"
      :class="block.status === 'error' ? 'text-red-600' : 'text-gray-400'"
    >
      {{ meta }}
    </div>

    <div v-if="expanded && hasDetails" class="mt-2 min-w-0">
      <div
        v-if="block.result?.error"
        class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700"
      >
        {{ block.result.error }}
      </div>

      <template v-else-if="block.presentation === 'shell'">
        <div
          class="overflow-hidden rounded-md border border-gray-200 bg-white font-mono text-[11px] leading-5"
        >
          <div v-if="command" class="flex border-b border-gray-200">
            <span class="w-10 shrink-0 px-2 py-1 text-gray-400">IN</span>
            <pre
              class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap wrap-break-word px-2 py-1 text-gray-700"
              >{{ command }}</pre>
          </div>
          <div v-if="shellOutput" class="flex">
            <span class="w-10 shrink-0 px-2 py-1 text-gray-400">OUT</span>
            <pre
              class="tool-output min-w-0 flex-1 overflow-auto whitespace-pre-wrap wrap-break-word px-2 py-1 text-gray-600"
              >{{ shellOutput }}</pre>
          </div>
        </div>
      </template>

      <pre
        v-else-if="block.presentation === 'read' && readContent"
        class="tool-output content-panel"
        >{{ readContent }}</pre>

      <pre
        v-else-if="block.presentation === 'write' && writeContent"
        class="tool-output content-panel"
        >{{ writeContent }}</pre>

      <div v-else-if="block.presentation === 'edit' && patches.length" class="space-y-3">
        <div
          v-for="(patch, patchIndex) in patches"
          :key="`${stringAt(patch, 'path')}:${patchIndex}`"
        >
          <div class="mb-1 font-mono text-[11px] text-gray-500">{{ stringAt(patch, 'path') }}</div>
          <div
            v-for="(replacement, replacementIndex) in arrayAt(patch, 'replacements')
              .map(asRecord)
              .filter(Boolean)"
            :key="replacementIndex"
            class="patch-preview grid overflow-hidden rounded-md border md:grid-cols-2"
          >
            <pre
              class="tool-output border-b border-red-950/80 bg-red-950/25 p-2 text-red-100 md:border-b-0 md:border-r"
            >
- {{ stringAt(replacement, 'oldText') }}</pre>
            <pre class="tool-output bg-emerald-950/25 p-2 text-emerald-100">
+ {{ stringAt(replacement, 'newText') }}</pre>
          </div>
        </div>
      </div>

      <pre v-else-if="detailText" class="tool-output content-panel">{{ detailText }}</pre>
      <pre v-else-if="rawArguments" class="tool-output content-panel">{{ rawArguments }}</pre>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.patch-preview {
  border-color: #374151;
  background: #111827;
}

.content-panel {
  @apply overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-5 text-gray-600;
}

.tool-output {
  max-height: 22rem;
  scrollbar-width: thin;
  scrollbar-color: rgb(203 213 225 / 0.8) transparent;
}
</style>
