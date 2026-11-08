<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { Check, ChevronDown, Folder } from '@lucide/vue';
import type { ProjectWorkspace } from '../../../../../shared/agent/workspace';
import FloatingMenu from '../../../components/FloatingMenu.vue';
import { projectName } from '../../utils';

const props = defineProps<{
  workspaces: ProjectWorkspace[];
  selected: ProjectWorkspace;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const menu = ref<InstanceType<typeof FloatingMenu>>();
const trigger = ref<HTMLButtonElement>();
const options = ref<HTMLElement>();

async function focusSelection(open: boolean) {
  if (!open) return;
  await nextTick();
  requestAnimationFrame(() => {
    options.value?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
}

function close() {
  menu.value?.close();
  trigger.value?.focus();
}

function handleKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === 'Tab') {
    close();
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.target instanceof HTMLButtonElement) {
      event.preventDefault();
      event.target.click();
    }
    return;
  }
  const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  if (!direction && event.key !== 'Home' && event.key !== 'End') return;
  event.preventDefault();
  const items = Array.from(options.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (Math.max(current, 0) + direction + items.length) % items.length;
  items[index]?.focus();
}

function handleFocusOut(event: FocusEvent) {
  if (event.relatedTarget && !options.value?.contains(event.relatedTarget as Node)) menu.value?.close();
}

function select(id: string) {
  close();
  emit('select', id);
}

function open() {
  if (trigger.value?.getAttribute('aria-expanded') !== 'true') trigger.value?.click();
}

</script>

<template>
  <FloatingMenu
    ref="menu"
    placement="bottom-start"
    trigger-class="min-w-0"
    menu-class="max-h-72 w-52 max-w-[calc(100vw-2rem)] overflow-y-auto"
    :close-on-menu-click="false"
    @update:open="focusSelection"
  >
    <template #trigger="{ open: expanded }">
      <button
        ref="trigger"
        class="flex min-w-0 items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 shadow-sm hover:bg-gray-50"
        type="button"
        aria-haspopup="menu"
        :aria-label="`${$t('ui.selectWorkspace')} · ${projectName(selected.path)}`"
        :aria-expanded="expanded"
        :title="selected.path"
        @keydown.down.prevent="open"
        @keydown.up.prevent="open"
        @keydown.esc.stop="close"
      >
        <span class="truncate">{{ projectName(selected.path) }}</span>
        <ChevronDown :size="13" class="shrink-0 text-gray-500" />
      </button>
    </template>
    <template #menu>
      <div ref="options" class="flex flex-col gap-0.5" role="menu" :aria-label="$t('ui.selectWorkspace')" @keydown="handleKeys" @focusout="handleFocusOut">
        <button
          v-for="workspace in props.workspaces"
          :key="workspace.id"
          type="button"
          role="menuitemradio"
          tabindex="-1"
          :aria-checked="workspace.id === selected.id"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none"
          @click="select(workspace.id)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-xs text-gray-800">{{ projectName(workspace.path) }}</span>
          </span>
        </button>
      </div>
    </template>
  </FloatingMenu>
</template>
