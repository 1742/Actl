<script setup lang="ts">
import { ref } from 'vue';
import { ChevronRight, Ellipsis, Folder, Pencil, Trash2 } from '@lucide/vue';
import FloatingMenu from '../../../components/FloatingMenu.vue';
import type { AgentProject } from '../../types';
import { projectName } from '../../utils';

defineProps<{
  projects: AgentProject[];
  canMove?: boolean;
}>();

const emit = defineEmits<{
  rename: [];
  delete: [];
  move: [projectId: string];
}>();

const menuRef = ref<{ close: () => void }>();

function run(action: 'rename' | 'delete') {
  if (action === 'rename') emit('rename');
  else emit('delete');
  menuRef.value?.close();
}

function move(projectId: string) {
  emit('move', projectId);
  menuRef.value?.close();
}
</script>

<template>
  <FloatingMenu ref="menuRef" placement="bottom-end" :close-on-menu-click="false">
    <template #trigger>
      <button type="button" :title="$t('ui.moreActions')" :aria-label="$t('ui.moreActions')">
        <Ellipsis :size="16" />
      </button>
    </template>

    <template #menu>
      <div class="w-38 text-sm text-gray-800">
        <button class="menu-item" type="button" @click="run('rename')">
          <Pencil :size="16" /><span>{{ $t('ui.rename') }}</span>
        </button>

        <FloatingMenu v-if="canMove" placement="right-start" trigger-class="w-full">
          <template #trigger>
            <button class="menu-item" type="button">
              <Folder :size="16" /><span class="flex-1">{{ $t('ui.moveToProject') }}</span
              ><ChevronRight :size="15" />
            </button>
          </template>
          <template #menu>
            <div class="max-h-72 w-52 overflow-y-auto text-sm text-gray-800">
              <button
                v-for="project in projects"
                :key="project.id"
                class="menu-item"
                type="button"
                :title="project.cwd"
                @click="move(project.id)"
              >
                <Folder :size="16" class="shrink-0" />
                <span class="truncate">{{ projectName(project.cwd, project.name) }}</span>
              </button>
              <p v-if="!projects.length" class="px-2.5 py-2 text-xs text-gray-400">
                {{ $t('ui.noProjects') }}
              </p>
            </div>
          </template>
        </FloatingMenu>

        <button
          class="menu-item text-red-600! hover:bg-red-50!"
          type="button"
          @click="run('delete')"
        >
          <Trash2 :size="16" /><span>{{ $t('ui.delete') }}</span>
        </button>
      </div>
    </template>
  </FloatingMenu>
</template>

<style scoped>
@reference "tailwindcss";
.menu-item {
  @apply flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-gray-100;
}
</style>
