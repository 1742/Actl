<script setup lang="ts">
import { ArchiveRestore, ArrowUpRight, Folder, MessageSquare, Trash2 } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useNotifyStore } from '../../../composables/notify';
import { currentLocale, tr } from '../../../i18n';
import { deleteAgentSession, selectAgentSession, setAgentSessionArchived } from '../../composables/useAgent';
import { useAgentStore } from '../../stores/agent';
import { conversationName, projectName } from '../../utils';
import AgentManageDialog from '../dialogs/AgentManageDialog.vue';
import type { RuntimeSession } from '../navigation/types';

const store = useAgentStore();
const router = useRouter();
const notify = useNotifyStore();
const busy = ref(false);
const deleteTarget = ref<RuntimeSession>();
const dateFormat = computed(() => new Intl.DateTimeFormat(currentLocale.value, { dateStyle: 'medium' }));
const groups = computed(() => {
  const byProject = new Map<string | null, RuntimeSession[]>();
  for (const session of store.archivedSessions) {
    const sessions = byProject.get(session.projectId) ?? [];
    sessions.push(session);
    byProject.set(session.projectId, sessions);
  }
  return [
    ...store.projects.map((project) => ({
      id: project.id,
      name: projectName(project.cwd, project.name),
      sessions: byProject.get(project.id) ?? [],
    })),
    { id: null, name: tr('ui.standaloneConversations'), sessions: byProject.get(null) ?? [] },
  ].filter(({ sessions }) => sessions.length);
});

async function openSession(sessionId: string) {
  busy.value = true;
  try {
    const result = await selectAgentSession(sessionId);
    if (result.status === 'error') {
      notify.error(result.message || tr('ui.failedToOpenConversation'));
      return;
    }
    await router.push({ name: 'aiAgent' });
  } finally {
    busy.value = false;
  }
}

async function restoreSession(sessionId: string) {
  busy.value = true;
  try {
    const result = await setAgentSessionArchived(sessionId, false);
    notify.display(result.status, result.message);
  } finally {
    busy.value = false;
  }
}

async function deleteSession() {
  if (!deleteTarget.value) return;
  busy.value = true;
  try {
    const { status, message } = await deleteAgentSession(deleteTarget.value.id);
    notify.display(status, message);
    if (status === 'success') deleteTarget.value = undefined;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <p v-if="!groups.length" class="rounded-xl border border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
    {{ $t('ui.noArchivedConversations') }}
  </p>
  <div v-else class="space-y-6">
    <section v-for="group in groups" :key="group.id ?? 'standalone'">
      <h2 class="mb-2 flex items-center gap-2 text-sm font-medium text-gray-900">
        <Folder v-if="group.id" :size="16" aria-hidden="true" />
        <MessageSquare v-else :size="16" aria-hidden="true" />
        {{ group.name }}
      </h2>
      <ul class="divide-y divide-gray-200 rounded-xl border border-gray-200">
        <li v-for="session in group.sessions" :key="session.id" class="flex items-center gap-1 px-2 py-1.5">
          <button
            class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-gray-100"
            type="button"
            :disabled="busy"
            :title="conversationName(session.title)"
            @click="openSession(session.id)"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-gray-900">{{ conversationName(session.title) }}</span>
              <time v-if="session.archived_at" class="text-xs text-gray-500" :datetime="session.archived_at">
                {{ dateFormat.format(new Date(session.archived_at)) }}
              </time>
            </span>
            <ArrowUpRight :size="15" class="shrink-0 text-gray-500" aria-hidden="true" />
          </button>
          <button
            class="archive-action"
            type="button"
            :disabled="busy"
            :aria-label="$t('ui.restoreConversation')"
            :title="$t('ui.restoreConversation')"
            @click="restoreSession(session.id)"
          >
            <ArchiveRestore :size="16" aria-hidden="true" />
          </button>
          <button
            class="archive-action hover:text-red-600"
            type="button"
            :disabled="busy"
            :aria-label="$t('ui.deleteConversation')"
            :title="$t('ui.deleteConversation')"
            @click="deleteTarget = session"
          >
            <Trash2 :size="16" aria-hidden="true" />
          </button>
        </li>
      </ul>
    </section>
  </div>

  <AgentManageDialog
    :open="Boolean(deleteTarget)"
    mode="delete-session"
    :target-name="deleteTarget ? conversationName(deleteTarget.title) : ''"
    :loading="busy"
    @close="deleteTarget = undefined"
    @submit="deleteSession"
  />
</template>

<style scoped>
@reference "tailwindcss";

.archive-action {
  @apply grid size-9 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-50;
}
</style>
