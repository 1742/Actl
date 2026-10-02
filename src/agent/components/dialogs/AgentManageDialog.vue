<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, ref, watch } from 'vue';
import { FolderOpen, X } from '@lucide/vue';
import { pickDirectory } from '../../composables/useFileBridge';
import type { AgentRuntimeKind } from '../../types';

type DialogMode = 'create-project' | 'rename-session' | 'delete-project' | 'delete-session';

const props = defineProps<{
  open: boolean;
  mode: DialogMode;
  initialValue?: string;
  targetName?: string;
  loading?: boolean;
  localProjectPaths?: boolean;
  runtimeKind?: AgentRuntimeKind;
  allowRuntimeSelection?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [value: string, runtimeKind: AgentRuntimeKind];
}>();

const inputRef = ref<HTMLInputElement>();
const value = ref('');
const selectingDirectory = ref(false);
const directoryError = ref('');
const selectedRuntime = ref<AgentRuntimeKind>('local');
const isCreate = computed(() => props.mode === 'create-project');
const isDelete = computed(() => props.mode.startsWith('delete-'));
const isLocalProject = computed(() => isCreate.value && selectedRuntime.value === 'local');
const canPickDirectory = computed(() => isLocalProject.value && props.localProjectPaths !== false);
const title = computed(
  () =>
    ({
      'create-project': tr('ui.addProject'),
      'rename-session': tr('ui.renameConversation'),
      'delete-project': tr('ui.deleteProject'),
      'delete-session': tr('ui.deleteConversation'),
    })[props.mode],
);

const canSubmit = computed(() => isDelete.value || Boolean(value.value.trim()));

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    value.value = props.initialValue || '';
    selectedRuntime.value = props.runtimeKind || 'local';
    await nextTick();
    inputRef.value?.focus();
  },
);

function submit() {
  if (!canSubmit.value || props.loading) return;
  emit('submit', value.value.trim(), selectedRuntime.value);
}

async function selectDirectory() {
  selectingDirectory.value = true;
  directoryError.value = '';
  try {
    const path = await pickDirectory();
    if (path) value.value = path;
  } catch (error) {
    directoryError.value = error instanceof Error ? error.message : tr('ui.failedToSelectFolder');
  } finally {
    selectingDirectory.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div
        v-if="open"
        class="fixed inset-0 z-60 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]"
        @mousedown.self="emit('close')"
      >
        <section
          class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
        >
          <header class="flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-gray-950">{{ title }}</h2>
            <button
              class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              type="button"
              @click="emit('close')"
            >
              <X :size="18" />
            </button>
          </header>

          <template v-if="isDelete">
            <p class="mt-4 text-sm leading-6 text-gray-600">
              {{ $t('dynamic.deleteNamed', { name: targetName }) }}
              <span v-if="mode === 'delete-project'" class="mt-2 block text-red-600">{{
                $t('ui.allConversationsAndRunRecordsIn')
              }}</span>
            </p>
          </template>

          <form v-else class="mt-4 space-y-4" @submit.prevent="submit">
            <label class="block">
              <span class="mb-1.5 block text-sm font-medium text-gray-700">{{
                isCreate
                  ? isLocalProject
                    ? $t('ui.projectPath')
                    : $t('ui.projectName')
                  : $t('ui.name')
              }}</span>
              <div class="flex gap-2">
                <input
                  ref="inputRef"
                  v-model="value"
                  class="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-100"
                  :placeholder="
                    isCreate
                      ? isLocalProject
                        ? $t('ui.forExampleDWorkspaceDemo')
                        : $t('ui.forExampleProductDocs')
                      : $t('ui.enterANewName')
                  "
                  @keydown.esc="emit('close')"
                />
                <button
                  v-if="canPickDirectory"
                  class="client-theme-text inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-300 px-3 text-sm disabled:cursor-not-allowed"
                  type="button"
                  :disabled="selectingDirectory"
                  @click="selectDirectory"
                >
                  <FolderOpen :size="16" />
                  {{ selectingDirectory ? $t('ui.selecting') : $t('ui.selectFolder') }}
                </button>
              </div>
              <p v-if="directoryError" class="mt-1.5 text-xs text-red-600">{{ directoryError }}</p>
            </label>
          </form>

          <footer class="mt-6 flex justify-end gap-2">
            <button
              class="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
              type="button"
              :disabled="loading"
              @click="emit('close')"
            >
              {{ $t('ui.cancel') }}
            </button>
            <button
              class="rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:opacity-100"
              :class="isDelete ? 'bg-red-600 text-white hover:bg-red-700' : 'client-primary-button'"
              type="button"
              :disabled="!canSubmit || loading"
              @click="submit"
            >
              {{
                loading
                  ? $t('ui.processing')
                  : isDelete
                    ? $t('ui.confirmDeletion')
                    : $t('ui.confirm')
              }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.client-theme-text {
  color: var(--color-primary);
}
.client-primary-button {
  background-color: var(--color-primary);
  color: var(--color-primary-fg);
}
.client-primary-button:hover:not(:disabled) {
  background-color: var(--color-primary-hover);
}
.client-primary-button:disabled {
  background-color: var(--color-gray-200);
  color: var(--color-gray-500);
}
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.15s ease;
}
.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}
</style>
