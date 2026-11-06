<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useNotifyStore } from '../../../composables/notify';
import ActivityBar from './ActivityBar.vue';
import SecondarySidebar from './SecondarySidebar.vue';
import AgentRecovery from '../conversation/AgentRecovery.vue';
import { bridge } from '../../../services/bridge';
import { useRuntimeStore } from '../../../stores/runtime';
import { ensureAgentRuntimeReady } from '../../services/runtimeUsecase';
import { getAgentRuntimeClient } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent.js';
import {
  initAgentSession,
  loadAgentModels,
  restoreInitialAgentView,
} from '../../composables/useAgent';

const isNavSidebarOpen = ref(false);
const store = useAgentStore();
const notify = useNotifyStore();
const route = useRoute();
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_MAIN_WIDTH = 360;
const NAV_SIDEBAR_WIDTH_STORAGE_KEY = 'ai-agent-sidebar-width';
const navSidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH);
const isResizingNavSidebar = ref(false);

function clampNavSidebarWidth(width: number) {
  const viewportLimit = Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - MIN_MAIN_WIDTH - 58);
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH, viewportLimit);
}

function saveNavSidebarWidth() {
  localStorage.setItem(NAV_SIDEBAR_WIDTH_STORAGE_KEY, String(navSidebarWidth.value));
}

function resizeNavSidebar(event: PointerEvent) {
  if (!isResizingNavSidebar.value) return;
  navSidebarWidth.value = clampNavSidebarWidth(event.clientX - 58);
}

function stopNavSidebarResize() {
  if (!isResizingNavSidebar.value) return;
  isResizingNavSidebar.value = false;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', resizeNavSidebar);
  window.removeEventListener('pointerup', stopNavSidebarResize);
  window.removeEventListener('pointercancel', stopNavSidebarResize);
  saveNavSidebarWidth();
}

function startNavSidebarResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  isResizingNavSidebar.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', resizeNavSidebar);
  window.addEventListener('pointerup', stopNavSidebarResize);
  window.addEventListener('pointercancel', stopNavSidebarResize);
}

function resetNavSidebarWidth() {
  navSidebarWidth.value = clampNavSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  saveNavSidebarWidth();
}

function handleNavSidebarResizeKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  navSidebarWidth.value = clampNavSidebarWidth(navSidebarWidth.value + direction * 16);
  saveNavSidebarWidth();
}

function constrainNavSidebarWidth() {
  navSidebarWidth.value = clampNavSidebarWidth(navSidebarWidth.value);
}

const openNavSidebar = () => {
  isNavSidebarOpen.value = true;
};

const closeNavSidebar = () => {
  isNavSidebarOpen.value = false;
};

const runtimeReadyState = computed(() => {
  const states = [store.runtimeAvailability.local];
  if (states.includes('available')) return 'ready';
  if (states.every((state) => state === 'unavailable')) return 'unavailable';
  return 'checking';
});
const runtimeError = computed(() => store.runtimeErrors.local);
async function initializeRuntime(kind: 'local') {
  store.setRuntimeAvailability(kind, 'checking');
  try {
    if (kind === 'local') await ensureAgentRuntimeReady();
  } catch (error) {
    store.setRuntimeAvailability(
      kind,
      'unavailable',
      error instanceof Error ? error.message : tr('ui.agentRuntimeFailedToStart'),
    );
    return;
  }
  const result = await initAgentSession(kind);
  if (result.status === 'success' && store.runtimeKind === kind) {
    store.configureRuntime(kind, getAgentRuntimeClient(kind).capabilities);
  }
}

async function initializeAgent(restart = false) {
  if (restart) {
    store.$reset();
    store.setRuntimeAvailability('local', 'checking');
    try {
      useRuntimeStore().apply(await bridge.restartAgent());
    } catch (error) {
      store.setRuntimeAvailability('local', 'unavailable', String(error));
      return;
    }
  }
  await initializeRuntime('local');
  if (store.runtimeAvailability.local !== 'available') return;
  const result = await restoreInitialAgentView();
  if (result.status === 'error')
    notify.error(result.message || tr('ui.failedToRestoreConversation'));
  else {
    const modelResult = await loadAgentModels();
    if (modelResult.status === 'error')
      notify.error(modelResult.message || tr('ui.failedToLoadModelList'));
  }
}

onMounted(() => {
  const savedWidth = Number(localStorage.getItem(NAV_SIDEBAR_WIDTH_STORAGE_KEY));
  if (Number.isFinite(savedWidth) && savedWidth > 0)
    navSidebarWidth.value = clampNavSidebarWidth(savedWidth);
  window.addEventListener('resize', constrainNavSidebarWidth);
  initializeAgent();
});

onUnmounted(() => {
  stopNavSidebarResize();
  window.removeEventListener('resize', constrainNavSidebarWidth);
});

watch(
  () => [store.runtimeKind, store.selectedSessionId] as const,
  async (current, previous) => {
    if ((current[0] === previous?.[0] && current[1] === previous?.[1]) || !store.initialized)
      return;
    const result = await loadAgentModels();
    if (result.status === 'error')
      notify.error(result.message || tr('ui.modelCompatibilityCheckFailed'));
  },
);
watch(() => route.fullPath, closeNavSidebar);
</script>

<template>
  <div class="agent-workspace relative flex h-full w-full overflow-hidden">
    <ActivityBar />
    <div class="agent-content-shell relative flex min-w-0 flex-1 overflow-hidden">
      <div
        class="relative hidden h-full shrink-0 border-r border-gray-200/80 sm:flex"
        :style="{ width: `${navSidebarWidth}px` }"
      >
        <SecondarySidebar />
        <div
          class="nav-sidebar-resize-handle"
          :class="{ 'nav-sidebar-resize-handle-active': isResizingNavSidebar }"
          role="separator"
          :aria-label="$t('ui.resizeSidebar')"
          aria-orientation="vertical"
          :aria-valuemin="MIN_SIDEBAR_WIDTH"
          :aria-valuemax="MAX_SIDEBAR_WIDTH"
          :aria-valuenow="Math.round(navSidebarWidth)"
          tabindex="0"
          :title="$t('ui.dragToResizeTheSidebarDouble')"
          @pointerdown="startNavSidebarResize"
          @dblclick="resetNavSidebarWidth"
          @keydown="handleNavSidebarResizeKeydown"
        ></div>
      </div>

      <Transition name="slide-left">
        <div
          v-if="isNavSidebarOpen"
          class="absolute inset-y-0 left-0 z-40 w-[min(19rem,calc(100vw-4rem))] sm:hidden"
        >
          <SecondarySidebar class="shadow-2xl" @close="closeNavSidebar" />
        </div>
      </Transition>

      <Transition name="fade">
        <div
          v-if="isNavSidebarOpen"
          class="absolute inset-0 z-30 bg-black/20 backdrop-blur-[2px] sm:hidden"
          @click="closeNavSidebar"
        ></div>
      </Transition>

      <main class="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <div
          v-if="runtimeReadyState === 'checking'"
          class="flex h-full w-full items-center justify-center bg-gray-50"
        >
          <div class="text-center" role="status">
            <div
              class="agent-runtime-spinner mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-4"
            ></div>
            <p class="text-sm text-gray-600">{{ $t('ui.connectingToAgent') }}</p>
          </div>
        </div>
        <AgentRecovery
          v-else-if="runtimeReadyState === 'unavailable' && $route.name === 'aiAgent'"
          :error="runtimeError"
          :retry="initializeAgent"
        />
        <router-view v-else @open-nav-sidebar="openNavSidebar" />
      </main>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.slide-left-enter-active,
.slide-left-leave-active {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.slide-left-enter-from,
.slide-left-leave-to {
  transform: translateX(-100%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.agent-runtime-spinner {
  border-color: var(--color-gray-200);
  border-top-color: var(--color-primary);
}

.agent-workspace {
  padding: 6px;
  background: var(--color-workspace);
}

.agent-content-shell {
  border: 1px solid var(--color-shell-border);
  border-radius: 14px;
  background: var(--color-white);
  box-shadow: 0 1px 3px #20242a08;
}

.nav-sidebar-resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  z-index: 10;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.nav-sidebar-resize-handle::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
  content: '';
  background: transparent;
  transition: background-color 0.15s ease;
}

.nav-sidebar-resize-handle:hover::after,
.nav-sidebar-resize-handle:focus-visible::after,
.nav-sidebar-resize-handle-active::after {
  background: color-mix(in srgb, var(--color-primary) 65%, transparent);
}
</style>
