<script setup lang="ts">
import { ref } from 'vue';
import { Ellipsis, Pencil, Trash2 } from '@lucide/vue';
import FloatingMenu from '../../../components/FloatingMenu.vue';

const emit = defineEmits<{
  rename: [];
  delete: [];
}>();

const menuRef = ref<{ close: () => void }>();

function run(action: 'rename' | 'delete') {
  if (action === 'rename') emit('rename');
  else emit('delete');
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
