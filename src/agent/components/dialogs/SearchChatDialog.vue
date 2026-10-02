<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, ref, watch } from 'vue';
import { FolderOpen, MessageCircle, Search, X } from '@lucide/vue';
import { useRouter } from 'vue-router';

import { useNotifyStore } from '../../../composables/notify';
import { useAgentStore } from '../../stores/agent';
import { selectAgentSession, startNewAgentDraft } from '../../composables/useAgent';
import { conversationName, projectName } from '../../utils';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const notify = useNotifyStore();
const store = useAgentStore();
const searchQuery = ref('');
const searchInput = ref<HTMLInputElement>();
const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLocaleLowerCase());
const matchingProjects = computed(() => {
  const query = normalizedSearchQuery.value;
  if (!query) return [];

  return store.projects.filter((project) =>
    [projectName(project.cwd, project.name), project.cwd].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
});
const matchingSessions = computed(() => {
  const query = normalizedSearchQuery.value;
  if (!query) return [];

  return store.sessions.filter((session) =>
    conversationName(session.title).toLocaleLowerCase().includes(query),
  );
});
const recentSessions = computed(() =>
  [...store.sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12),
);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      searchQuery.value = '';
      return;
    }
    await nextTick();
    searchInput.value?.focus();
  },
);

function close() {
  emit('close');
}

async function openSession(sessionId: string) {
  if (sessionId !== store.selectedSessionId) {
    const result = await selectAgentSession(sessionId);
    if (result.status === 'error') {
      notify.error(result.message || tr('ui.failedToOpenConversation'));
      return;
    }
  }

  await router.push({ name: 'aiAgent' });
  close();
}

async function selectProject(projectId: string) {
  const result = startNewAgentDraft(projectId);
  if (result.status === 'error') {
    notify.error(result.message || tr('ui.couldNotCreateANewConversation'));
    return;
  }
  if (result.status === 'success') {
    await router.push({ name: 'aiAgent' });
    close();
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="search-dialog-backdrop" @mousedown.self="close">
      <section
        class="search-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('ui.searchProjectsAndConversations')"
        @keydown.escape="close"
      >
        <header class="search-dialog-header">
          <label class="search-dialog-input">
            <Search :size="18" aria-hidden="true" />
            <input
              ref="searchInput"
              v-model="searchQuery"
              type="text"
              inputmode="search"
              :placeholder="$t('ui.searchProjectsAndConversations')"
              :aria-label="$t('ui.searchProjectsAndConversations')"
            />
          </label>
          <button
            type="button"
            class="search-dialog-close"
            :aria-label="$t('ui.closeSearch')"
            :title="$t('ui.off')"
            @click="close"
          >
            <X :size="18" />
          </button>
        </header>

        <div class="search-dialog-results">
          <template v-if="normalizedSearchQuery">
            <p v-if="matchingProjects.length" class="search-dialog-heading">
              {{ $t('ui.projects') }}
            </p>
            <button
              v-for="project in matchingProjects"
              :key="project.id"
              type="button"
              class="search-dialog-result"
              :title="project.cwd"
              @click="selectProject(project.id)"
            >
              <FolderOpen :size="17" class="shrink-0" />
              <span class="min-w-0 truncate">{{ projectName(project.cwd, project.name) }}</span>
            </button>

            <p
              v-if="matchingSessions.length"
              class="search-dialog-heading"
              :class="{ 'mt-3': matchingProjects.length }"
            >
              {{ $t('ui.conversations') }}
            </p>
            <button
              v-for="session in matchingSessions"
              :key="session.id"
              type="button"
              class="search-dialog-result"
              @click="openSession(session.id)"
            >
              <MessageCircle :size="17" class="shrink-0" />
              <span class="min-w-0 truncate">{{ conversationName(session.title) }}</span>
            </button>

            <p
              v-if="!matchingProjects.length && !matchingSessions.length"
              class="dialog-muted px-3 py-5 text-sm"
            >
              {{ $t('ui.noMatchingProjectsOrConversations') }}
            </p>
          </template>
          <template v-else>
            <p class="search-dialog-heading">{{ $t('ui.recentChats') }}</p>
            <button
              v-for="session in recentSessions"
              :key="session.id"
              type="button"
              class="search-dialog-result"
              @click="openSession(session.id)"
            >
              <MessageCircle :size="17" class="shrink-0" />
              <span class="min-w-0 truncate">{{ conversationName(session.title) }}</span>
            </button>
            <p v-if="!recentSessions.length" class="dialog-muted px-3 py-5 text-sm">
              {{ $t('ui.noConversations') }}
            </p>
          </template>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
@reference "tailwindcss";

.search-dialog-backdrop {
  @apply fixed inset-0 z-60 flex items-start justify-center bg-black/20 px-4 pt-[15vh] backdrop-blur-[1px];
}

.search-dialog {
  @apply flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl;
  max-height: min(62vh, 34rem);
  color: var(--color-sidebar-fg);
  border-color: var(--color-sidebar-divider);
  background-color: var(--color-sidebar-bg);
}

.search-dialog-header {
  @apply flex items-center gap-3 border-b px-5 py-4;
  border-color: var(--color-sidebar-divider);
}

.search-dialog-input {
  @apply flex min-w-0 flex-1 items-center gap-3;
  color: var(--color-sidebar-muted);
}

.search-dialog-input input {
  @apply min-w-0 flex-1 bg-transparent text-base outline-none;
  color: var(--color-sidebar-fg);
}

.search-dialog-input input::placeholder,
.dialog-muted,
.search-dialog-heading {
  color: var(--color-sidebar-muted);
}

.search-dialog-close {
  @apply flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors;
  color: var(--color-sidebar-muted);
}

.search-dialog-close:hover,
.search-dialog-result:hover {
  background-color: var(--color-sidebar-hover);
}

.search-dialog-results {
  @apply min-h-0 overflow-y-auto px-2 py-3;
}

.search-dialog-heading {
  @apply px-3 pb-2 text-xs font-medium;
}

.search-dialog-result {
  @apply flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors;
  color: var(--color-sidebar-fg);
}
</style>
