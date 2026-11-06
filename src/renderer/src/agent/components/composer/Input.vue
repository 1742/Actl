<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { CircleAlert, FileText, LoaderCircle, Plus, X } from '@lucide/vue';

import AgentMessageInputFloating from './AgentMessageInputFloating.vue';
import PermissionPanel from '../permissions/PermissionPanel.vue';
import PermissionModeSelector from '../permissions/PermissionModeSelector.vue';
import AgentComposerEditor from './AgentComposerEditor.vue';
import SearchChatDialog from '../dialogs/SearchChatDialog.vue';
import { useNotifyStore } from '../../../composables/notify';
import { pickFiles, releaseSelections } from '../../composables/useFileBridge.ts';
import type { PickedFile } from '../../composables/useFileBridge.ts';
import {
  loadAgentSkills,
  selectAgentModel,
  selectAgentReasoning,
  sendAgentMessage,
  stopAgentResponse,
} from '../../composables/useAgent';
import { useAgentStore } from '../../stores/agent.ts';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { composerPlainText, createEmptyAgentComposer } from '../../composables/useAgentComposer';
import { resolveAgentComposer } from '../../utils';
import type {
  AgentComposerAttachment,
  AgentComposerContextKey,
  AgentComposerDocument,
  RuntimeReasoningEffort,
} from '../../types';

interface ComposerEditorHandle {
  focus: () => void;
  openReferenceMenu: (type: 'skill' | 'file') => void;
}

const agentStore = useAgentStore();
const notify = useNotifyStore();
const router = useRouter();
const composerEditorRef = ref<ComposerEditorHandle>();
const attachmentPanelRef = ref<HTMLElement>();
const attachmentPanelHeight = ref(0);
const document = ref<AgentComposerDocument>(createEmptyAgentComposer());
const attachments = ref<AgentComposerAttachment[]>([]);
const submitting = ref(false);
const compressing = ref(false);
const searchChatOpen = ref(false);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
let attachmentPanelObserver: ResizeObserver | undefined;

const model = computed({
  get: () => agentStore.selectedModel,
  set: async (value: string) => {
    const result = await selectAgentModel(value);
    if (result.status === 'error') notify.error(result.message || tr('ui.failedToSwitchModel'));
  },
});
const modelOptions = computed(() =>
  agentStore.models
    .filter((item) => item.enabled && item.compatible !== false)
    .map((item) => ({
      label: item.displayName,
      value: item.id,
    })),
);
const reasoningLabels = computed<Record<RuntimeReasoningEffort, string>>(() => ({
  none: tr('ui.off'),
  minimal: tr('ui.minimal'),
  low: tr('ui.low'),
  medium: tr('ui.medium'),
  high: tr('ui.high'),
  xhigh: tr('ui.extraHigh'),
  max: tr('ui.maximum'),
}));
const reasoningOptions = computed(() =>
  (
    agentStore.models.find((item) => item.id === model.value)?.capabilities.reasoningEfforts ?? []
  ).map((effort) => ({
    value: effort,
    label: reasoningLabels.value[effort],
    ...(effort === 'max' ? { description: tr('ui.usesYourQuotaFaster') } : {}),
  })),
);
const reasoningEffort = computed({
  get: () => agentStore.selectedReasoningEffort,
  set: async (value: RuntimeReasoningEffort | undefined) => {
    const result = await selectAgentReasoning(value);
    if (result.status === 'error')
      notify.error(result.message || tr('ui.failedToChangeReasoningEffort'));
  },
});
const permissionMode = computed({
  get: () => agentStore.selectedPermissionMode,
  set: (value) => agentStore.selectPermissionMode(value),
});
const projectId = computed(() => agentStore.session?.projectId || agentStore.draftProjectId || '');
const projectActivityOwner = computed(() =>
  projectId.value ? agentStore.projectActivityOwner(projectId.value) : undefined,
);
const projectBlocked = computed(() =>
  Boolean(
    projectActivityOwner.value && projectActivityOwner.value !== agentStore.selectedSessionId,
  ),
);
const disabled = computed(
  () =>
    agentStore.isWaitingPermission ||
    agentStore.loadingHistory ||
    projectBlocked.value ||
    compressing.value,
);
const compressionPercent = computed(() => {
  const window = agentStore.models.find((item) => item.id === model.value)?.capabilities
    .contextWindow;
  const tokens = agentStore.currentRuntime?.context?.last_input_tokens;
  return window && tokens ? Math.min(100, Math.round((tokens / window) * 100)) : 0;
});
const compressionAvailable = computed(() =>
  Boolean(
    agentStore.session &&
    model.value &&
    !agentStore.sessionIsActive(agentStore.selectedSessionId) &&
    !compressing.value,
  ),
);
const skillContextKey = computed(() =>
  agentStore.selectedSessionId
    ? `session:${agentStore.selectedSessionId}`
    : agentStore.draftProjectId
      ? `project:${agentStore.draftProjectId}`
      : 'user',
);
const resolvedInput = computed(() => {
  const resolved = resolveAgentComposer(document.value);
  if (resolved.error) return resolved;

  const skillNodes = document.value.nodes.filter((node) => node.type === 'skill');
  if (!skillNodes.length) return resolved;
  if (agentStore.skillsLoading) return { content: [], error: tr('ui.loadingTheSkillList') };
  if (agentStore.skillsError) return { content: [], error: agentStore.skillsError };

  for (const node of skillNodes) {
    const skill = agentStore.skills.find((item) => item.id === node.id);
    if (!skill) return { content: [], error: tr('dynamic.skillMissing', { name: node.name }) };
    if (!skill.available) {
      const diagnostic = skill.diagnostics[0];
      return {
        content: [],
        error: diagnostic?.message
          ? tr('dynamic.skillUnavailableReason', { reason: diagnostic.message })
          : tr('dynamic.skillUnavailable', { name: node.name }),
      };
    }
  }

  return resolved;
});
const hasComposerContent = computed(() =>
  document.value.nodes.some((node) => node.type !== 'text' || Boolean(node.text.trim())),
);
const canSend = computed(
  () =>
    (resolvedInput.value.content.length > 0 || attachments.value.length > 0) &&
    (!hasComposerContent.value || !resolvedInput.value.error) &&
    Boolean(model.value) &&
    !agentStore.isRunning &&
    !submitting.value &&
    !disabled.value,
);
const placeholder = computed(() =>
  agentStore.isWaitingPermission
    ? tr('ui.resolveThePermissionRequestFirst')
    : projectBlocked.value
      ? tr('ui.anotherConversationInThisProjectIs')
      : agentStore.loadingHistory
        ? tr('ui.loadingConversationHistory')
        : !agentStore.modelsLoading && agentStore.modelsLoaded && !model.value
          ? tr('ui.configureAnAgentModelFirst')
          : tr('ui.enterAnInstruction'),
);
const inputError = computed(() =>
  hasComposerContent.value ? resolvedInput.value.error || '' : '',
);

function cloneDocument(source: AgentComposerDocument): AgentComposerDocument {
  return {
    version: 1,
    nodes: source.nodes.map((node) => ({ ...node })),
  };
}

function cloneAttachments(source: AgentComposerAttachment[]) {
  return source.map((attachment) => ({
    ...attachment,
    storedFile: attachment.storedFile ? { ...attachment.storedFile } : undefined,
  }));
}

function createAttachmentId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isAgentReadable(attachment: AgentComposerAttachment) {
  const type = attachment.selected.mimeType.toLowerCase();
  if (
    type.startsWith('text/') ||
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)
  )
    return true;
  const extension = attachment.selected.name.split('.').at(-1)?.toLowerCase() || '';
  return [
    'txt',
    'md',
    'markdown',
    'json',
    'jsonl',
    'csv',
    'tsv',
    'yaml',
    'yml',
    'xml',
    'html',
    'css',
    'js',
    'jsx',
    'ts',
    'tsx',
    'dart',
    'py',
    'java',
    'kt',
    'cs',
    'c',
    'cpp',
    'h',
    'hpp',
    'go',
    'rs',
    'rb',
    'php',
    'sh',
    'ps1',
    'bat',
    'sql',
    'toml',
    'ini',
    'env',
  ].includes(extension);
}

async function appendAttachments(selected: PickedFile[]) {
  if (!selected.length) return;
  const accepted: PickedFile[] = [];
  let totalBytes = attachments.value.reduce((total, item) => total + item.selected.size, 0);
  let rejection = '';
  for (const file of selected) {
    if (attachments.value.length + accepted.length >= MAX_ATTACHMENTS) {
      rejection = tr('dynamic.attachmentLimit', { count: MAX_ATTACHMENTS });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejection = tr('dynamic.attachmentTooLarge', { name: file.name });
      continue;
    }
    if (totalBytes + file.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
      rejection = tr('ui.totalAttachmentSizeCannotExceed100');
      continue;
    }
    totalBytes += file.size;
    accepted.push(file);
  }
  const acceptedSet = new Set(accepted);
  const rejected = selected.filter((file) => !acceptedSet.has(file));
  if (rejected.length) await releaseSelections(rejected);
  attachments.value.push(
    ...accepted.map((selected) => ({
      id: createAttachmentId(),
      selected,
      status: 'pending' as const,
    })),
  );
  if (rejection) notify.error(rejection);
}

async function addAttachments() {
  if (disabled.value) return;
  try {
    const selected = await pickFiles({ multiple: true, purpose: 'agent-attachment' });
    await appendAttachments(selected);
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToSelectFile'));
  }
}

function pastedImageExtension(mimeType: string) {
  const subtype = mimeType.toLowerCase().split('/')[1]?.split(';')[0] || 'png';
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype.replace(/[^a-z0-9]+/g, '') || 'png';
}

async function addPastedImages(files: File[]) {
  if (disabled.value || !files.length) return;
  const timestamp = Date.now();
  const selected = files.map((file, index): PickedFile => ({
    source: 'browser',
    file,
    name:
      file.name.trim() ||
      `pasted-image-${timestamp}-${index + 1}.${pastedImageExtension(file.type)}`,
    mimeType: file.type,
    size: file.size,
    lastModified: file.lastModified,
  }));
  await appendAttachments(selected);
}

async function removeAttachment(attachment: AgentComposerAttachment) {
  if (attachment.status === 'uploading' || disabled.value) return;
  attachments.value = attachments.value.filter((item) => item.id !== attachment.id);
  await releaseSelections([attachment.selected]);
}

function updateAttachment(
  target: AgentComposerAttachment[],
  attachmentId: string,
  changes: Partial<Pick<AgentComposerAttachment, 'status' | 'storedFile' | 'error'>>,
) {
  const attachment = target.find((item) => item.id === attachmentId);
  if (attachment) Object.assign(attachment, changes);
}

function openReferenceMenu(type: 'skill' | 'file') {
  composerEditorRef.value?.openReferenceMenu(type);
}

function openRecentChats() {
  searchChatOpen.value = true;
}

async function send() {
  if (!canSend.value) return;

  const sourceKey = agentStore.draftContextKey;
  const snapshot = cloneDocument(document.value);
  const attachmentSnapshot = cloneAttachments(attachments.value);
  const content = resolvedInput.value.content;

  submitting.value = true;
  document.value = createEmptyAgentComposer();
  attachments.value = [];
  agentStore.clearComposerDraft(sourceKey);
  agentStore.clearAttachmentDraft(sourceKey);

  const updateSendingAttachment = (
    attachmentId: string,
    changes: Partial<Pick<AgentComposerAttachment, 'status' | 'storedFile' | 'error'>>,
  ) => updateAttachment(attachmentSnapshot, attachmentId, changes);

  try {
    const { status, message, data } = await sendAgentMessage(
      content,
      attachmentSnapshot,
      updateSendingAttachment,
      permissionMode.value,
    );
    if (status === 'error') {
      const failedSessionId = (data as { sessionId?: string } | undefined)?.sessionId;
      const restoreKey = failedSessionId ? (`session:${failedSessionId}` as const) : sourceKey;
      const restoredAttachments = cloneAttachments(attachmentSnapshot);
      agentStore.setComposerDraft(restoreKey, snapshot);
      agentStore.setAttachmentDraft(restoreKey, restoredAttachments);
      if (agentStore.draftContextKey === restoreKey) {
        document.value = cloneDocument(snapshot);
        attachments.value = cloneAttachments(restoredAttachments);
      }
      notify.error(message || tr('ui.failedToSend'));
      return;
    }
    await releaseSelections(attachmentSnapshot.map((attachment) => attachment.selected));
  } finally {
    submitting.value = false;
  }
}

async function stop() {
  const result = await stopAgentResponse(agentStore.selectedSessionId);
  notify.display(result.status, result.message);
}

async function compressContext() {
  const session = agentStore.session;
  if (!session || !model.value || !compressionAvailable.value) return;
  compressing.value = true;
  agentStore.setCompressionInProgress(session.id, true);
  try {
    const { client } = getAgentRuntimeContext(session.runtimeKind);
    const result = await client.compactSession(
      session.runtimeId,
      model.value,
      reasoningEffort.value,
    );
    const history = await client.getContext(session.runtimeId);
    agentStore.setContextSummary(session.id, history.context);
    notify.success(
      result.compressed
        ? tr('ui.olderConversationContextCompressed')
        : tr('ui.noOlderConversationCanBeCompressed'),
    );
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToCompressContext'));
  } finally {
    compressing.value = false;
    agentStore.setCompressionInProgress(session.id, false);
  }
}

watch(
  attachmentPanelRef,
  (panel) => {
    attachmentPanelObserver?.disconnect();
    attachmentPanelObserver = undefined;
    attachmentPanelHeight.value = panel?.offsetHeight || 0;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    attachmentPanelObserver = new ResizeObserver(() => {
      attachmentPanelHeight.value = panel.offsetHeight;
    });
    attachmentPanelObserver.observe(panel);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => attachmentPanelObserver?.disconnect());

watch(
  () => (agentStore.initialized ? skillContextKey.value : ''),
  (contextKey) => {
    if (!contextKey) return;
    void loadAgentSkills();
  },
  { immediate: true },
);

watch(
  () => agentStore.draftContextKey,
  (contextKey) => {
    const cached = agentStore.composerDrafts[contextKey];
    document.value = cached ? cloneDocument(cached) : createEmptyAgentComposer();
    attachments.value = cloneAttachments(agentStore.attachmentDrafts[contextKey] || []);
  },
  { immediate: true },
);

watch(
  document,
  (draft) => {
    agentStore.setComposerDraft(
      agentStore.draftContextKey as AgentComposerContextKey,
      cloneDocument(draft),
    );
  },
  { deep: true },
);

watch(
  attachments,
  (draft) => {
    agentStore.setAttachmentDraft(
      agentStore.draftContextKey as AgentComposerContextKey,
      cloneAttachments(draft),
    );
  },
  { deep: true },
);
</script>

<template>
  <div class="shrink-0 bg-white pt-3">
    <div class="mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8">
      <div
        v-if="agentStore.modelsLoaded && !agentStore.models.length"
        class="mb-2 flex items-center justify-center gap-1 text-xs text-amber-700"
      >
        <span>{{ $t('ui.noUsableModelIsConfigured') }}</span>
        <button
          v-if="agentStore.runtimeCapabilities.modelConfiguration"
          class="font-medium underline underline-offset-2"
          type="button"
          @click="router.push({ name: 'aiAgentSettings' })"
        >
          {{ $t('ui.goToSettings') }}
        </button>
      </div>

      <div v-if="inputError" class="mb-1 flex items-center gap-1 px-2 text-xs text-amber-700">
        <CircleAlert :size="13" class="shrink-0" />
        <span>{{ inputError }}</span>
      </div>

      <AgentMessageInputFloating
        :model-value="composerPlainText(document)"
        v-model:model="model"
        v-model:reasoning-effort="reasoningEffort"
        :model-options="modelOptions"
        :reasoning-options="reasoningOptions"
        show-reasoning-control
        :placeholder="placeholder"
        :loading="agentStore.isRunning"
        :stop-disabled="
          agentStore.isStopping ||
          !agentStore.activeResponseId ||
          agentStore.activeResponseId.startsWith('local-')
        "
        :disabled="disabled"
        :can-submit="canSend"
        :hide-composer="Boolean(agentStore.pendingPermissionBatch)"
        :layout-key="`${document.nodes.length}:${attachments.length}`"
        @submit="send"
        @stop="stop"
      >
        <template #attachments>
          <PermissionPanel v-if="agentStore.pendingPermissionBatch" />
          <div
            ref="attachmentPanelRef"
            v-else-if="attachments.length"
            class="flex flex-wrap gap-2 px-4 pb-2 pt-3"
          >
            <div
              v-for="attachment in attachments"
              :key="attachment.id"
              class="flex min-w-0 max-w-72 items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-2.5 py-2"
              :title="
                isAgentReadable(attachment)
                  ? attachment.selected.name
                  : $t('dynamic.attachmentUnreadable', { name: attachment.selected.name })
              "
            >
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-gray-500"
              >
                <LoaderCircle
                  v-if="attachment.status === 'uploading'"
                  :size="16"
                  class="animate-spin"
                />
                <FileText v-else :size="16" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-gray-700">{{
                  attachment.selected.name
                }}</span>
                <span
                  class="block truncate text-[11px]"
                  :class="
                    attachment.status === 'error' || !isAgentReadable(attachment)
                      ? 'text-amber-600'
                      : 'text-gray-400'
                  "
                >
                  <template v-if="attachment.status === 'uploading'">{{
                    $t('ui.uploading')
                  }}</template>
                  <template v-else-if="attachment.status === 'uploaded'">{{
                    $t('dynamic.attachmentUploaded', {
                      size: formatFileSize(attachment.selected.size),
                    })
                  }}</template>
                  <template v-else-if="attachment.status === 'error'">{{
                    attachment.error || $t('ui.uploadFailedWillRetryWhenSending')
                  }}</template>
                  <template v-else-if="!isAgentReadable(attachment)">{{
                    $t('dynamic.attachmentMayBeUnreadable', {
                      size: formatFileSize(attachment.selected.size),
                    })
                  }}</template>
                  <template v-else>{{
                    $t('dynamic.attachmentPending', {
                      size: formatFileSize(attachment.selected.size),
                    })
                  }}</template>
                </span>
              </span>
              <button
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-200 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                :disabled="attachment.status === 'uploading' || disabled"
                :aria-label="$t('dynamic.removeAttachment', { name: attachment.selected.name })"
                @click="removeAttachment(attachment)"
              >
                <X :size="14" />
              </button>
            </div>
          </div>
        </template>

        <template #editor>
          <AgentComposerEditor
            ref="composerEditorRef"
            v-model="document"
            :skills="agentStore.runtimeCapabilities.skills ? agentStore.skills : []"
            :skills-loading="agentStore.skillsLoading"
            :skills-error="agentStore.skillsError"
            :project-id="
              agentStore.runtimeCapabilities.workspace
                ? agentStore.draftProject?.runtimeId || agentStore.session?.runtimeProjectId || ''
                : ''
            "
            :runtime-kind="agentStore.runtimeKind"
            :placeholder="placeholder"
            :disabled="disabled"
            :compression-available="compressionAvailable"
            :compression-percent="compressionPercent"
            :menu-offset="attachmentPanelHeight"
            :attachment-action-disabled="attachments.length >= MAX_ATTACHMENTS"
            @add-attachments="addAttachments"
            @open-recent-chats="openRecentChats"
            @paste-images="addPastedImages"
            @compress-context="compressContext"
            @submit="send"
          />
        </template>

        <template #left-tools>
          <button
            v-if="agentStore.runtimeCapabilities.skills || agentStore.runtimeCapabilities.workspace"
            class="composer-tool"
            type="button"
            :disabled="disabled"
            :aria-label="$t('ui.openQuickMenu')"
            v-tooltip="$t('ui.quickActionsSkillsAndMcp')"
            @click="openReferenceMenu('skill')"
          >
            <Plus :size="18" />
          </button>
          <div v-if="agentStore.runtimeCapabilities.permissions" class="hidden sm:block">
            <PermissionModeSelector v-model="permissionMode" :disabled="disabled" />
          </div>
        </template>
      </AgentMessageInputFloating>
      <SearchChatDialog :open="searchChatOpen" @close="searchChatOpen = false" />
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.composer-tool {
  @apply flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50;
}
</style>
