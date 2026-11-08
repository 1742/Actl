<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { FolderOpen, RefreshCw } from '@lucide/vue';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import type { WorkspaceFilePreview } from '../../../../../shared/agent/workspace';
import { useNotifyStore } from '../../../composables/notify';
import { tr } from '../../../i18n';
import { getAgentRuntimeContext } from '../../services/runtimeClient';

const props = defineProps<{ projectId: string; path: string }>();
const revision = ref(0);
const preview = shallowRef<WorkspaceFilePreview>();
const imageUrl = ref('');
const failed = ref(false);
const loading = ref(true);
const revealing = ref(false);
const notify = useNotifyStore();

async function revealFile() {
  revealing.value = true;
  try {
    const found = await window.actlAgent.revealWorkspaceFile(props.projectId, props.path);
    if (!found) notify.error(tr('ui.missingWorkspacePreview'));
  } catch {
    notify.error(tr('ui.failedToRevealWorkspaceFile'));
  } finally {
    revealing.value = false;
  }
}

watch(() => [props.projectId, props.path, revision.value] as const, async ([projectId, path], _, onCleanup) => {
  let current = true;
  let url = '';
  onCleanup(() => {
    current = false;
    if (url) URL.revokeObjectURL(url);
  });
  preview.value = undefined;
  imageUrl.value = '';
  failed.value = false;
  loading.value = true;
  try {
    const { client } = getAgentRuntimeContext('local');
    const result = await client.previewWorkspaceFile(projectId, path);
    if (!current) return;
    if (result.kind === 'image') {
      url = URL.createObjectURL(new Blob([new Uint8Array(result.bytes)], { type: result.mediaType }));
      imageUrl.value = url;
    }
    preview.value = result;
  } catch {
    if (current) failed.value = true;
  } finally {
    if (current) loading.value = false;
  }
}, { immediate: true });

const source = computed(() => preview.value?.kind === 'text' ? preview.value.text : '');
const lineNumbers = computed(() => {
  const count = source.value.split(/\r\n|\r|\n/).length;
  return Array.from({ length: count }, (_, index) => index + 1).join('\n');
});
const highlighted = computed(() => {
  const extension = props.path.split('.').at(-1)?.toLowerCase();
  if (!extension || source.value.length > 200_000 || !hljs.getLanguage(extension)) return '';
  return hljs.highlight(source.value, { language: extension, ignoreIllegals: true }).value;
});
const statusKey = computed(() => {
  if (loading.value) return 'ui.loadingWorkspacePreview';
  if (failed.value) return 'ui.failedWorkspacePreview';
  if (preview.value?.kind === 'missing') return 'ui.missingWorkspacePreview';
  if (preview.value?.kind === 'too-large') return 'ui.largeWorkspacePreview';
  if (preview.value?.kind === 'unsupported') return 'ui.unsupportedWorkspacePreview';
  return '';
});
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-white">
    <header class="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-xs text-gray-600">
      <span
        class="min-w-0 truncate rounded-full border border-gray-200 bg-white px-3 py-1.5 shadow-sm"
        :title="path"
      >{{ path }}</span>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex size-8 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm transition-colors enabled:hover:bg-gray-100 disabled:opacity-50"
          type="button"
          :aria-label="$t('ui.revealWorkspaceFile')"
          :title="$t('ui.revealWorkspaceFile')"
          :disabled="revealing"
          @click="revealFile"
        >
          <FolderOpen :size="14" />
        </button>
        <button
          class="flex size-8 items-center justify-center rounded-full border border-gray-200 bg-white shadow-sm transition-colors enabled:hover:bg-gray-100 disabled:opacity-50"
          type="button"
          :aria-label="$t('ui.refresh')"
          :title="$t('ui.refresh')"
          :disabled="loading"
          @click="revision++"
        >
          <RefreshCw :size="14" />
        </button>
      </div>
    </header>
    <p v-if="statusKey" role="status" class="px-4 py-8 text-center text-sm text-gray-500">{{ $t(statusKey) }}</p>
    <div v-else-if="preview?.kind === 'text'" class="preview-scroll mr-1 mb-1 min-h-0 flex-1 overflow-auto">
      <div class="flex w-max min-w-full font-mono text-xs leading-5">
        <pre aria-hidden="true" class="sticky left-0 shrink-0 select-none border-r border-gray-200 bg-white px-2 py-3 text-right text-gray-400">{{ lineNumbers }}</pre>
        <pre class="px-3 py-3 text-gray-800"><code v-if="highlighted" v-html="highlighted"></code><code v-else>{{ source }}</code></pre>
      </div>
    </div>
    <div v-else-if="imageUrl" class="preview-scroll mr-1 mb-1 min-h-0 flex-1 overflow-auto bg-gray-50 p-3">
      <img class="mx-auto block h-auto max-w-full" :src="imageUrl" :alt="path" @error="failed = true" />
    </div>
  </section>
</template>

<style scoped>
.preview-scroll::-webkit-scrollbar {
  height: 4px;
}

.preview-scroll::-webkit-scrollbar-track:horizontal {
  margin-inline: 6px;
}

.preview-scroll::-webkit-scrollbar-track:vertical {
  margin-block: 6px;
}
</style>
