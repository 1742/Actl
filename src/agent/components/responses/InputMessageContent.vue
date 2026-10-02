<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Download, FileText, Package, Plug } from '@lucide/vue';

import type { AIFileContent, AIResponseContent } from '../../types/aiResponse.ts';
import { readContentText } from '../../utils/aiResponse.ts';
import MessageHtml from './MessageHtml.vue';

const props = withDefaults(
  defineProps<{
    parts: AIResponseContent[];
    skillNames?: Record<string, string>;
    sessionId?: string;
    loadFilePreview?: (file: AIFileContent, sessionId: string) => Promise<string | undefined>;
  }>(),
  {
    skillNames: () => ({}),
  },
);
const emit = defineEmits<{
  downloadFile: [file: AIFileContent];
}>();

const uploadedFiles = computed(() =>
  props.parts.filter((part): part is AIFileContent => part.type === 'input_file'),
);
const generatedPreviewSources = ref<Record<string, string>>({});
let previewGeneration = 0;

const previewableMimeTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function clearGeneratedPreviewSources() {
  Object.values(generatedPreviewSources.value).forEach((url) => URL.revokeObjectURL(url));
  generatedPreviewSources.value = {};
}

function isPreviewableImage(file: AIFileContent) {
  const mimeType =
    typeof file.mime_type === 'string' ? file.mime_type.split(';', 1)[0].trim().toLowerCase() : '';
  return previewableMimeTypes.has(mimeType);
}

async function loadFilePreviews() {
  const generation = ++previewGeneration;
  clearGeneratedPreviewSources();
  if (!props.sessionId || !props.loadFilePreview) return;

  const files = uploadedFiles.value.filter(
    (file) =>
      !file.preview_src &&
      isPreviewableImage(file) &&
      typeof file.file_id === 'string' &&
      file.file_id,
  );
  const fileIds = new Set<string>();
  await Promise.all(
    files.map(async (file) => {
      const fileId = file.file_id;
      if (typeof fileId !== 'string' || !fileId) return;
      if (fileIds.has(fileId)) return;
      fileIds.add(fileId);
      try {
        const source = await props.loadFilePreview!(file, props.sessionId!);
        if (!source) return;
        if (generation !== previewGeneration) {
          URL.revokeObjectURL(source);
          return;
        }
        generatedPreviewSources.value[fileId] = source;
      } catch {
        // Preview failures intentionally fall back to the existing file card.
      }
    }),
  );
}

function previewSource(file: AIFileContent) {
  return (
    file.preview_src || (file.file_id ? generatedPreviewSources.value[file.file_id] : undefined)
  );
}

watch(() => [props.sessionId, props.parts, props.loadFilePreview], loadFilePreviews, {
  immediate: true,
  deep: true,
});
onBeforeUnmount(() => {
  previewGeneration += 1;
  clearGeneratedPreviewSources();
});

const hasInlineReferences = computed(() =>
  props.parts.some(
    (part) =>
      part.type === 'input_skill' ||
      part.type === 'input_workspace_file' ||
      part.type === 'input_mcp_server',
  ),
);
const plainText = computed(() => readContentText(props.parts, 'input_text'));
const hasBubbleContent = computed(
  () => hasInlineReferences.value || props.parts.some((part) => part.type === 'input_text'),
);

function fileLabel(part: AIResponseContent) {
  if (part.type === 'input_workspace_file') {
    const path = typeof part.path === 'string' ? part.path : '';
    return path.split('/').at(-1) || path || tr('ui.files');
  }
  if (part.type !== 'input_file') return tr('ui.files');
  const name = part.filename || part.name || part.file_id;
  return typeof name === 'string' ? name : tr('ui.files');
}

function fileTitle(part: AIResponseContent) {
  if (part.type === 'input_workspace_file') return typeof part.path === 'string' ? part.path : '';
  return fileLabel(part);
}

function formatFileSize(part: AIFileContent) {
  if (typeof part.bytes !== 'number' || part.bytes < 0) return '';
  if (part.bytes < 1024) return `${part.bytes} B`;
  if (part.bytes < 1024 * 1024) return `${(part.bytes / 1024).toFixed(1)} KB`;
  return `${(part.bytes / 1024 / 1024).toFixed(1)} MB`;
}

function skillId(part: AIResponseContent) {
  return typeof part.id === 'string' ? part.id : '';
}

function skillLabel(part: AIResponseContent) {
  const id = skillId(part);
  return (
    (part.type === 'input_skill' ? part.name : undefined) || props.skillNames[id] || id || 'Skill'
  );
}
</script>

<template>
  <div class="flex max-w-full flex-col items-end gap-1.5">
    <div v-if="uploadedFiles.length" class="flex max-w-full flex-wrap justify-end gap-1.5">
      <template v-for="(part, index) in uploadedFiles" :key="index">
        <div
          v-if="previewSource(part)"
          class="group relative max-w-full overflow-hidden rounded-xl"
          :title="fileTitle(part)"
        >
          <img
            :src="previewSource(part)"
            :alt="fileLabel(part)"
            class="block max-h-72 max-w-full rounded-xl object-contain sm:max-w-80"
          />
          <button
            class="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-lg bg-black/55 text-white shadow-sm backdrop-blur-sm hover:bg-black/70 hover:cursor-pointer"
            type="button"
            v-tooltip="$t('ui.downloadFile')"
            :aria-label="$t('dynamic.downloadNamed', { name: fileLabel(part) })"
            @click="emit('downloadFile', part)"
          >
            <Download :size="16" />
          </button>
        </div>

        <button
          v-else
          class="flex max-w-60 items-center gap-2 rounded-xl border border-gray-200 bg-white p-1.5 pr-2 text-left text-gray-600 shadow-sm"
          type="button"
          :title="fileTitle(part)"
          :aria-label="$t('dynamic.downloadAttachment', { name: fileLabel(part) })"
          @click="emit('downloadFile', part)"
        >
          <span
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500"
          >
            <FileText :size="20" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs font-medium text-gray-700">{{
              fileLabel(part)
            }}</span>
            <span v-if="formatFileSize(part)" class="block text-[11px] text-gray-400">{{
              formatFileSize(part)
            }}</span>
          </span>
        </button>
      </template>
    </div>

    <div
      v-if="hasBubbleContent"
      class="rounded-2xl bg-gray-100 px-3 py-1.5 text-[14px] leading-relaxed text-gray-900"
    >
      <MessageHtml v-if="!hasInlineReferences" :html-string="plainText" :is-invert="false" />

      <div
        v-else
        class="flex flex-wrap items-baseline gap-x-1 gap-y-1 whitespace-pre-wrap wrap-break-word text-sm leading-6 sm:text-base sm:leading-7"
      >
        <template v-for="(part, index) in parts" :key="index">
          <span v-if="part.type === 'input_text'" class="min-w-0">{{ part.text }}</span>

          <span
            v-else-if="part.type === 'input_skill'"
            class="message-skill-reference inline-flex max-w-full items-center gap-1 font-medium"
            :title="skillId(part)"
          >
            <Package :size="12" class="shrink-0" />
            <span class="truncate">/{{ skillLabel(part) }}</span>
          </span>

          <span
            v-else-if="part.type === 'input_mcp_server'"
            class="message-skill-reference inline-flex max-w-full items-center gap-1 font-medium"
            :title="typeof part.name === 'string' ? part.name : ''"
          >
            <Plug :size="12" class="shrink-0" />
            <span class="truncate">/mcp:{{ part.name }}</span>
          </span>

          <span
            v-else-if="part.type === 'input_workspace_file'"
            class="message-file-reference inline-flex max-w-full items-center gap-1 font-medium"
            :title="fileTitle(part)"
          >
            <FileText :size="12" class="shrink-0" />
            <span class="truncate">{{ fileLabel(part) }}</span>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.message-skill-reference {
  color: color-mix(in srgb, var(--color-primary) 65%, var(--color-gray-900));
}

.message-file-reference {
  color: color-mix(in srgb, var(--color-primary) 65%, var(--color-gray-900));
}
</style>
