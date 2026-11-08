<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, ref, watch } from 'vue';
import { Folder, FolderPlus, X } from '@lucide/vue';
import { pickDirectory } from '../../composables/useFileBridge';
import { projectName } from '../../utils';
import type { AgentProject, ProjectSettings } from '../../../../../shared/agent/sessions';

export type DialogMode = 'create-project' | 'edit-project' | 'rename-session' | 'delete-project' | 'delete-session';

const props = defineProps<{
  open: boolean;
  mode: DialogMode;
  initialValue?: string;
  targetName?: string;
  loading?: boolean;
  project?: AgentProject;
}>();

const emit = defineEmits<{
  close: [];
  submit: [value: string];
  submitProject: [settings: ProjectSettings];
  deleteProject: [];
}>();

const inputRef = ref<HTMLInputElement>();
const value = ref('');
const selectingDirectory = ref(false);
const directoryError = ref('');
const workspacePaths = ref<string[]>([]);
const primaryWorkspacePath = ref('');
let dialogVersion = 0;
let defaultFirstWorkspace = true;
const isProjectForm = computed(() => props.mode === 'create-project' || props.mode === 'edit-project');
const isDelete = computed(() => props.mode.startsWith('delete-'));
const title = computed(
  () =>
    ({
      'create-project': tr('ui.addProject'),
      'edit-project': tr('ui.editProject'),
      'rename-session': tr('ui.renameConversation'),
      'delete-project': tr('ui.deleteProject'),
      'delete-session': tr('ui.deleteConversation'),
    })[props.mode],
);

const canSubmit = computed(() => isDelete.value || (isProjectForm.value
  ? workspacePaths.value.includes(primaryWorkspacePath.value) && !selectingDirectory.value
  : Boolean(value.value.trim())));

watch(
  [() => props.open, () => props.mode],
  async ([open]) => {
    dialogVersion++;
    if (!open) return;
    value.value = props.initialValue || '';
    workspacePaths.value = props.project?.workspaces.map(({ path }) => path) ?? [];
    primaryWorkspacePath.value = props.project?.workspaces.find(({ id }) => id === props.project?.primaryWorkspaceId)?.path ?? '';
    directoryError.value = '';
    selectingDirectory.value = false;
    defaultFirstWorkspace = props.mode === 'create-project';
    await nextTick();
    inputRef.value?.focus();
  },
);

function submit() {
  if (!canSubmit.value || props.loading) return;
  if (isProjectForm.value) {
    emit('submitProject', {
      name: value.value.trim() || undefined,
      workspacePaths: [...workspacePaths.value],
      primaryWorkspacePath: primaryWorkspacePath.value,
    });
  } else {
    emit('submit', value.value.trim());
  }
}

function addDirectory(directory: string) {
  if (props.loading) return;
  if (workspacePaths.value.includes(directory)) {
    directoryError.value = tr('ui.workspaceAlreadyAdded');
    return;
  }
  workspacePaths.value.push(directory);
  if (defaultFirstWorkspace) {
    primaryWorkspacePath.value = directory;
    defaultFirstWorkspace = false;
  }
  directoryError.value = '';
}

function removeDirectory(directory: string) {
  workspacePaths.value = workspacePaths.value.filter((item) => item !== directory);
  if (primaryWorkspacePath.value === directory) primaryWorkspacePath.value = '';
}

async function selectDirectory() {
  const version = dialogVersion;
  selectingDirectory.value = true;
  directoryError.value = '';
  try {
    const path = await pickDirectory();
    if (path && version === dialogVersion) addDirectory(path);
  } catch (error) {
    if (version === dialogVersion) directoryError.value = error instanceof Error ? error.message : tr('ui.failedToSelectFolder');
  } finally {
    if (version === dialogVersion) selectingDirectory.value = false;
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
          class="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          @keydown.esc.stop="emit('close')"
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
              <span class="mb-1.5 block text-sm font-medium text-gray-700">{{ $t(isProjectForm ? 'ui.projectName' : 'ui.name') }}</span>
              <div class="flex gap-2">
                <input
                  ref="inputRef"
                  v-model="value"
                  class="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-100"
                  :placeholder="isProjectForm && primaryWorkspacePath ? projectName(primaryWorkspacePath) : $t('ui.enterANewName')"
                  :disabled="loading"
                />
              </div>
            </label>
            <fieldset v-if="isProjectForm" class="min-w-0" :disabled="loading">
              <legend class="mb-1.5 text-sm font-medium text-gray-700">{{ $t('ui.sourceFolders') }}</legend>
              <div class="divide-y divide-gray-200 rounded-xl border border-gray-200">
                <div v-for="directory in workspacePaths" :key="directory" class="group/workspace flex items-center gap-2 px-3 py-2 text-sm">
                  <Folder :size="16" class="shrink-0 text-gray-500" />
                  <span class="min-w-0 flex-1" :title="directory">
                    <span class="block truncate">{{ projectName(directory) }}</span>
                    <span class="block truncate text-xs text-gray-500">{{ directory }}</span>
                  </span>
                  <span
                    v-if="directory === primaryWorkspacePath"
                    class="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600"
                  >
                    {{ $t('ui.primaryWorkspaceBadge') }}
                  </span>
                  <button
                    v-else
                    type="button"
                    class="pointer-events-none shrink-0 rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-700 opacity-0 group-hover/workspace:pointer-events-auto group-hover/workspace:opacity-100 hover:bg-gray-200 focus-visible:opacity-100"
                    @click="primaryWorkspacePath = directory"
                  >
                    {{ $t('ui.setPrimaryWorkspace') }}
                  </button>
                  <button type="button" class="rounded p-1 text-gray-500 hover:bg-gray-100" :title="$t('ui.removeWorkspace')" :aria-label="$t('ui.removeWorkspace')" @click="removeDirectory(directory)">
                    <X :size="14" />
                  </button>
                </div>
                <button type="button" class="flex w-full items-center gap-2 px-3 py-4 text-left text-sm hover:bg-gray-50" :disabled="selectingDirectory" @click="selectDirectory">
                  <FolderPlus :size="16" />
                  {{ selectingDirectory ? $t('ui.selecting') : $t('ui.addSourceFolder') }}
                </button>
              </div>
              <p v-if="directoryError" class="mt-1.5 text-xs text-red-600" role="alert">{{ directoryError }}</p>
            </fieldset>
          </form>

          <footer class="mt-6 flex justify-end gap-2">
            <button v-if="mode === 'edit-project'" type="button" class="mr-auto rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100" :disabled="loading" @click="emit('deleteProject')">
              {{ $t('ui.deleteProject') }}
            </button>
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
                    : $t(isProjectForm ? 'ui.save' : 'ui.confirm')
              }}
            </button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
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
