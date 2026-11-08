<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, ref, shallowRef } from 'vue';
import {
  Ellipsis,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Trash2,
} from '@lucide/vue';
import { useRouter } from 'vue-router';

import { useNotifyStore } from '../../../composables/notify';
import FloatingMenu from '../../../components/FloatingMenu.vue';
import { enterAgentConversation } from '../../router';
import type { ProjectSettings } from '../../../../../shared/agent/sessions';
import AgentManageDialog, { type DialogMode } from '../dialogs/AgentManageDialog.vue';
import AgentSessionMenu from '../dialogs/AgentSessionMenu.vue';
import SearchChatDialog from '../dialogs/SearchChatDialog.vue';
import { useAgentStore } from '../../stores/agent.ts';
import type { RuntimeProject, RuntimeSession } from './types';
import {
  createAgentProject,
  deleteAgentProject,
  deleteAgentSession,
  renameAgentSession,
  selectAgentSession,
  startNewAgentDraft,
  updateAgentProject,
} from '../../composables/useAgent';
import { conversationName, projectName } from '../../utils';

const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const notify = useNotifyStore();
const store = useAgentStore();

const collapsedProjects = ref(new Set<string>());
const projectContext = shallowRef<{ id: string; anchor: DOMRect }>();
const searchOpen = ref(false);
const dialog = ref<{
  open: boolean;
  mode: DialogMode;
  project?: RuntimeProject;
  session?: RuntimeSession;
}>({
  open: false,
  mode: 'create-project',
});
const dialogLoading = ref(false);

function sessionStatus(sessionId: string) {
  return store.runtimeBySessionId[sessionId]?.status || 'idle';
}

async function openSession(sessionId: string) {
  if (sessionId !== store.selectedSessionId) {
    const result = await selectAgentSession(sessionId);
    if (result.status === 'error') {
      notify.error(result.message || tr('ui.failedToOpenConversation'));
      return;
    }
  }

  await enterAgentConversation(router);
  emit('close');
}

async function startDraft(projectId?: string) {
  const result = startNewAgentDraft(projectId);
  if (result.status === 'error') {
    notify.error(result.message || tr('ui.couldNotCreateANewConversation'));
    return;
  }
  if (result.status === 'success') {
    await enterAgentConversation(router);
    emit('close');
  }
}

function toggleProject(projectId: string) {
  const next = new Set(collapsedProjects.value);
  if (next.has(projectId)) {
    next.delete(projectId);
  } else {
    next.add(projectId);
  }
  collapsedProjects.value = next;
}

function openProjectContextMenu(id: string, event: MouseEvent) {
  projectContext.value = { id, anchor: new DOMRect(event.clientX, event.clientY) };
}

async function openProjectDirectory(project: RuntimeProject) {
  try {
    await window.actlAgent.openProjectDirectory(project.runtimeId);
  } catch {
    notify.error(tr('ui.couldNotOpenFolder'));
  }
}

function openSearch() {
  searchOpen.value = true;
}

function closeSearch() {
  searchOpen.value = false;
}

function showDialog(mode: DialogMode, target?: RuntimeProject | RuntimeSession) {
  dialog.value = {
    open: true,
    mode,
    project: mode.includes('project') ? (target as RuntimeProject | undefined) : undefined,
    session: mode.includes('session') ? (target as RuntimeSession | undefined) : undefined,
  };
}

function closeDialog() {
  if (!dialogLoading.value) dialog.value.open = false;
}

async function submitDialog(value: string) {
  dialogLoading.value = true;
  const current = dialog.value;
  let result;

  if (current.mode === 'delete-project' && current.project)
    result = await deleteAgentProject(current.project.id);
  else if (current.mode === 'rename-session' && current.session)
    result = await renameAgentSession(current.session.id, value);
  else if (current.mode === 'delete-session' && current.session)
    result = await deleteAgentSession(current.session.id);

  dialogLoading.value = false;
  if (!result) return;
  notify.display(result.status, result.message);
  if (result.status === 'success') dialog.value.open = false;
}

async function submitProject(settings: ProjectSettings) {
  const current = dialog.value;
  const isCreate = current.mode === 'create-project';
  if (!isCreate && !current.project) return;
  dialogLoading.value = true;
  const result = isCreate ? await createAgentProject(settings) : await updateAgentProject(current.project!.id, settings);
  dialogLoading.value = false;
  notify.display(result.status, result.message);
  if (result.status !== 'success') return;
  dialog.value.open = false;
  if (isCreate) {
    await enterAgentConversation(router);
    emit('close');
  }
}

const dialogInitialValue = computed(() =>
  dialog.value.project
    ? projectName(dialog.value.project.cwd, dialog.value.project.name)
    : dialog.value.session?.title || '',
);

const dialogTargetName = computed(() =>
  dialog.value.project
    ? projectName(dialog.value.project.cwd, dialog.value.project.name)
    : conversationName(dialog.value.session?.title),
);
</script>

<template>
  <aside class="agent-nav-sidebar flex h-full w-full flex-col overflow-hidden p-2 text-sm">
    <div class="sidebar-topbar">
      <span class="sidebar-brand">Actl</span>
      <button
        class="sidebar-collapse-button"
        type="button"
        :title="$t('ui.searchConversations')"
        :aria-label="$t('ui.searchConversations')"
        @click="openSearch"
      >
        <Search :size="17" />
      </button>
    </div>
    <div class="space-y-0.5 pt-1">
      <button class="nav-action" type="button" @click="startDraft()">
        <MessageSquarePlus :size="17" />
        <span>{{ $t('ui.newConversation') }}</span>
      </button>
      <button
        class="nav-action"
        type="button"
        @click="showDialog('create-project')"
      >
        <FolderOpen :size="17" />
        <span>{{ $t('ui.addProject') }}</span>
      </button>
    </div>
    <div class="mt-5 min-h-0 flex-1 overflow-y-auto px-1 pb-5">
      <div class="sidebar-muted mb-2 px-2 text-md">{{ $t('ui.projects') }}</div>

      <p v-if="!store.projects.length" class="sidebar-muted px-2 py-2 text-xs">
        {{ $t('ui.noProjects') }}
      </p>

      <p
        v-if="store.runtimeAvailability.local === 'unavailable'"
        class="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-700"
        :title="store.runtimeErrors.local"
      >
        {{ $t('ui.localAgentIsUnavailable') }}
      </p>

      <section v-for="project in store.projects" :key="project.id" class="mb-2">
        <div
          class="sidebar-row group"
          :class="{ 'sidebar-row-selected': project.id === store.draftProjectId }"
          @contextmenu.prevent="openProjectContextMenu(project.id, $event)"
        >
          <button
            class="flex h-9 min-w-0 flex-1 items-center pl-1 text-left"
            type="button"
            :aria-expanded="!collapsedProjects.has(project.id)"
            :aria-label="
              $t('dynamic.projectConversations', {
                action: collapsedProjects.has(project.id) ? $t('ui.expand') : $t('ui.collapse'),
                name: projectName(project.cwd, project.name),
              })
            "
            @click="toggleProject(project.id)"
          >
            <span class="flex w-6 shrink-0 items-center justify-center">
              <Folder
                v-if="collapsedProjects.has(project.id)"
                :size="16"
                class="runtime-icon runtime-icon-local"
                aria-hidden="true"
              />
              <FolderOpen
                v-else
                :size="16"
                class="runtime-icon runtime-icon-local"
                aria-hidden="true"
              />
            </span>
            <span class="min-w-0 flex-1 truncate pl-1 font-medium" :title="project.cwd">
              {{ projectName(project.cwd, project.name) }}
            </span>
          </button>
          <LoaderCircle
            v-if="
              store.projectActivityOwner(project.id) &&
              (sessionStatus(store.projectActivityOwner(project.id)!) === 'running' ||
                sessionStatus(store.projectActivityOwner(project.id)!) === 'stopping')
            "
            :size="14"
            class="mr-2 shrink-0 animate-spin text-primary"
            :aria-label="$t('ui.sessionRunning')"
          />

          <div class="sidebar-row-overlay row-actions">
            <button :title="$t('ui.createConversation')" @click="startDraft(project.id)">
              <Plus :size="14" />
            </button>
            <FloatingMenu
              placement="bottom-end"
              :context-anchor="projectContext?.id === project.id ? projectContext.anchor : null"
            >
              <template #trigger="{ open }">
                <button
                  class="project-menu-trigger"
                  type="button"
                  :title="$t('ui.moreActions')"
                  :aria-label="$t('ui.moreActions')"
                  :aria-expanded="open"
                >
                  <Ellipsis :size="16" />
                </button>
              </template>
              <template #menu>
                <div class="w-max max-w-64 text-sm text-gray-800">
                  <button class="project-menu-item hover:bg-gray-100" type="button" @click="openProjectDirectory(project)">
                    <FolderOpen :size="16" class="shrink-0" />
                    <span>{{ $t('ui.openProjectDirectory') }}</span>
                  </button>
                  <button class="project-menu-item hover:bg-gray-100" type="button" @click="showDialog('edit-project', project)">
                    <Pencil :size="16" class="shrink-0" />
                    <span>{{ $t('ui.editProject') }}</span>
                  </button>
                  <button class="project-menu-item text-red-600 hover:bg-red-50" type="button" @click="showDialog('delete-project', project)">
                    <Trash2 :size="16" class="shrink-0" />
                    <span>{{ $t('ui.deleteProject') }}</span>
                  </button>
                </div>
              </template>
            </FloatingMenu>
          </div>
        </div>

        <div v-if="!collapsedProjects.has(project.id)" class="mt-0.5">
          <div
            v-for="session in store.sessionsByProject(project.id)"
            :key="session.id"
            class="conversation-row group"
            :class="{ 'sidebar-row-selected': session.id === store.selectedSessionId }"
          >
            <button
              class="min-w-0 flex-1 truncate py-1.5 pl-8 pr-3 text-left"
              type="button"
              @click="openSession(session.id)"
            >
              {{ conversationName(session.title) }}
            </button>
            <div
              v-if="sessionStatus(session.id) === 'waiting_permission'"
              class="sidebar-row-overlay permission-waiting-overlay"
            >
              <span class="permission-waiting-badge">{{ $t('ui.awaitingApproval') }}</span>
            </div>
            <LoaderCircle
              v-else-if="
                sessionStatus(session.id) === 'running' || sessionStatus(session.id) === 'stopping'
              "
              :size="14"
              class="mr-2 shrink-0 animate-spin text-primary"
              :aria-label="$t('ui.sessionRunning')"
            />
            <div class="sidebar-row-overlay row-actions">
              <AgentSessionMenu
                @rename="showDialog('rename-session', session)"
                @delete="showDialog('delete-session', session)"
              />
            </div>
          </div>
          <p
            v-if="!store.sessionsByProject(project.id).length"
            class="sidebar-muted py-1.5 pl-8 text-xs"
          >
            {{ $t('ui.emptyConversations') }}
          </p>
        </div>
      </section>

      <section class="mt-4">
        <div class="sidebar-muted mb-2 px-2 text-md">{{ $t('ui.conversation') }}</div>
        <div
          v-for="session in store.standaloneSessions"
          :key="session.id"
          class="conversation-row group"
          :class="{ 'sidebar-row-selected': session.id === store.selectedSessionId }"
        >
          <button
            class="min-w-0 flex-1 truncate py-1.5 pl-2 pr-3 text-left"
            type="button"
            @click="openSession(session.id)"
          >
            {{ conversationName(session.title) }}
          </button>
          <div
            v-if="sessionStatus(session.id) === 'waiting_permission'"
            class="sidebar-row-overlay permission-waiting-overlay"
          >
            <span class="permission-waiting-badge">{{ $t('ui.waitingForPermission') }}</span>
          </div>
          <LoaderCircle
            v-else-if="
              sessionStatus(session.id) === 'running' || sessionStatus(session.id) === 'stopping'
            "
            :size="14"
            class="mr-2 shrink-0 animate-spin text-primary"
            :aria-label="$t('ui.sessionRunning')"
          />
          <div class="sidebar-row-overlay row-actions">
            <AgentSessionMenu
              @rename="showDialog('rename-session', session)"
              @delete="showDialog('delete-session', session)"
            />
          </div>
        </div>
        <p v-if="!store.standaloneSessions.length" class="sidebar-muted px-2 py-1 text-xs">
          {{ $t('ui.noConversations') }}
        </p>
      </section>
    </div>

    <AgentManageDialog
      :open="dialog.open"
      :mode="dialog.mode"
      :initial-value="dialogInitialValue"
      :target-name="dialogTargetName"
      :loading="dialogLoading"
      :project="dialog.project"
      @close="closeDialog"
      @submit="submitDialog"
      @submit-project="submitProject"
      @delete-project="showDialog('delete-project', dialog.project)"
    />

    <SearchChatDialog :open="searchOpen" @close="closeSearch" />
  </aside>
</template>

<style scoped>
@reference "tailwindcss";

.nav-action {
  @apply flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-300 ease-out;
}

.nav-action:hover {
  background-color: var(--color-sidebar-hover);
}

.agent-nav-sidebar {
  color: var(--color-sidebar-fg);
  background-color: var(--color-sidebar-bg);
}

.sidebar-collapse-button {
  @apply flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-200;
  color: var(--color-sidebar-fg);
}

.sidebar-collapse-button:hover {
  background-color: var(--color-sidebar-hover);
}

.sidebar-collapse-button {
  @apply h-8 w-8;
  color: var(--color-sidebar-muted);
}

.sidebar-brand {
  @apply min-w-0 truncate px-2 text-sm font-semibold tracking-tight;
  color: var(--color-sidebar-fg);
}

.sidebar-topbar {
  @apply grid grid-cols-[minmax(0,1fr)_2rem] items-center px-1 pt-1;
}

.sidebar-muted {
  color: var(--color-sidebar-muted);
}

.runtime-icon {
  color: var(--color-sidebar-muted);
}

.sidebar-row,
.conversation-row {
  @apply relative flex w-full items-center rounded-lg transition-colors duration-300 ease-out;
  color: var(--color-sidebar-fg);
}

.sidebar-row:hover,
.conversation-row:hover {
  background-color: var(--color-sidebar-hover);
}

.sidebar-row-selected {
  color: var(--color-sidebar-fg);
  background-color: var(--color-sidebar-selected);
}

.conversation-row + .conversation-row {
  @apply mt-1;
}

.sidebar-row-overlay {
  --sidebar-overlay-background: var(--color-sidebar-bg);
  @apply isolate absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center;
  background-color: var(--sidebar-overlay-background);
}

.sidebar-row-overlay::before {
  position: absolute;
  top: 0;
  right: calc(100% - 1px);
  bottom: 0;
  z-index: -1;
  width: 0.75rem;
  content: '';
  background: linear-gradient(to right, transparent, var(--sidebar-overlay-background));
}

.sidebar-row:hover .sidebar-row-overlay,
.conversation-row:hover .sidebar-row-overlay {
  --sidebar-overlay-background: var(--color-sidebar-hover);
}

.sidebar-row-selected .sidebar-row-overlay {
  --sidebar-overlay-background: var(--color-sidebar-selected);
}

.permission-waiting-badge {
  @apply rounded-md bg-emerald-50 px-1.5 py-0.5 text-[12px] font-medium text-emerald-700;
}

.conversation-row:hover .permission-waiting-overlay {
  @apply opacity-0;
}

.row-actions {
  @apply z-20 hidden pl-3 group-hover:flex;
}

.sidebar-row:focus-within .row-actions,
.row-actions:has(.project-menu-trigger[aria-expanded='true']) {
  display: flex;
}

.row-actions > button,
.project-menu-trigger {
  @apply flex h-7 w-7 items-center justify-center rounded transition-colors duration-300 ease-out;
  color: var(--color-sidebar-muted);
}

.row-actions > button:hover,
.project-menu-trigger:hover {
  color: var(--color-sidebar-fg);
  background-color: var(--color-sidebar-hover);
}

.project-menu-item {
  @apply flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left;
}
</style>
