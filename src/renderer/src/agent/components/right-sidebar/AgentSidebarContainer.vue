<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from "vue-router";

const router = useRouter();
const DEFAULT_WIDTH = 520;
const STORAGE_KEY = 'ai-agent-right-sidebar-width';
const panel = ref<HTMLElement>();
const preferredWidth = ref(DEFAULT_WIDTH);
const availableWidth = ref(window.innerWidth);
const maxWidth = computed(() => Math.max(0, Math.min(800, availableWidth.value - 360)));
const minWidth = computed(() => Math.min(280, maxWidth.value));
const width = computed(() => clampWidth(preferredWidth.value));
const isResizing = ref(false);
let observer: ResizeObserver | undefined;
let drag: { handle: HTMLElement; pointerId: number; x: number; width: number; cursor: string; userSelect: string } | undefined;

function clampWidth(value: number) {
  return Math.min(maxWidth.value, Math.max(minWidth.value, value));
}

function saveWidth() {
  localStorage.setItem(STORAGE_KEY, String(preferredWidth.value));
}

function startResize(event: PointerEvent) {
  if (event.button !== 0 || drag) return;
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  drag = { handle, pointerId: event.pointerId, x: event.clientX, width: width.value,
    cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
  isResizing.value = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('blur', stopResize);
}

function resize(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  preferredWidth.value = clampWidth(drag.width + drag.x - event.clientX);
}

function stopResize() {
  if (!drag) return;
  const current = drag;
  drag = undefined;
  isResizing.value = false;
  document.body.style.cursor = current.cursor;
  document.body.style.userSelect = current.userSelect;
  window.removeEventListener('blur', stopResize);
  if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  saveWidth();
}

function resetWidth() {
  preferredWidth.value = DEFAULT_WIDTH;
  saveWidth();
}

function handleKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') resetWidth();
  else {
    preferredWidth.value = clampWidth(width.value + (event.key === 'ArrowLeft' ? 16 : -16));
    saveWidth();
  }
}

watch(panel, (element) => {
  stopResize();
  observer?.disconnect();
  const parent = element?.parentElement;
  if (!parent) return;
  availableWidth.value = parent.clientWidth;
  observer = new ResizeObserver(() => { availableWidth.value = parent.clientWidth; });
  observer.observe(parent);
}, { flush: 'post' });
watch(() => router.currentRoute.value.name, (name) => {
  if (name !== 'aiAgentRightSidebarHome') stopResize();
});

onMounted(() => {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) preferredWidth.value = saved;
});
onUnmounted(() => { stopResize(); observer?.disconnect(); });

async function closeRightSidebar() {
  await router.push({ name: "aiAgent" });
}
</script>

<template>
  <router-view v-slot="{ Component }">
    <Transition name="right-sidebar-panel">
      <div
        v-show="Component"
        ref="panel"
        class="right-sidebar-panel relative h-full min-h-0 overflow-hidden border-l border-gray-200 bg-white"
        :style="{ '--sidebar-width': `${width}px` }"
      >
        <div
          class="right-sidebar-resize-handle"
          :class="{ 'is-resizing': isResizing }"
          role="separator"
          aria-orientation="vertical"
          :aria-label="$t('ui.resizeSidebar')"
          :aria-valuemin="minWidth"
          :aria-valuemax="maxWidth"
          :aria-valuenow="Math.round(width)"
          :title="$t('ui.dragToResizeTheSidebarDouble')"
          tabindex="0"
          @pointerdown="startResize"
          @pointermove="resize"
          @pointerup="stopResize"
          @pointercancel="stopResize"
          @lostpointercapture="stopResize"
          @dblclick="resetWidth"
          @keydown="handleKeydown"
        />
        <KeepAlive>
          <component :is="Component" v-if="Component" @close="closeRightSidebar" />
        </KeepAlive>
      </div>
    </Transition>
  </router-view>
</template>

<style scoped>
.right-sidebar-panel {
  flex: 0 0 var(--sidebar-width);
  width: var(--sidebar-width);
}

.right-sidebar-resize-handle {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 10;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}

.right-sidebar-resize-handle::after {
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  content: '';
  background: transparent;
  transition: background-color 0.15s ease;
}

.right-sidebar-resize-handle:hover::after,
.right-sidebar-resize-handle:focus-visible::after,
.right-sidebar-resize-handle.is-resizing::after {
  background: color-mix(in srgb, var(--color-primary) 65%, transparent);
}

.right-sidebar-panel-enter-active,
.right-sidebar-panel-leave-active {
  overflow: hidden;
  transition: flex-basis 0.25s ease, width 0.25s ease;
}

.right-sidebar-panel-enter-from,
.right-sidebar-panel-leave-to {
  width: 0;
  flex-basis: 0;
}
</style>
