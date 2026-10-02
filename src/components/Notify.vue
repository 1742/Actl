<script setup lang="ts">
import { Check, CircleX, Hourglass, Info, X } from '@lucide/vue';
import { useNotifyStore } from '../composables/notify';

const notify = useNotifyStore();
</script>

<template>
  <div class="notify-host">
    <div
      v-for="item in notify.items"
      :key="item.id"
      class="notify"
      :class="item.type"
    >
      <span v-if="item.type === 'loading'" class="icon">
        <Hourglass :size="16" />
      </span>
      <span v-else-if="item.type === 'success'" class="icon text-green-500">
        <Check :size="16" />
      </span>
      <span v-else-if="item.type === 'error'" class="icon text-red-500">
        <CircleX :size="16" />
      </span>
      <span v-else class="icon text-blue-400">
        <Info :size="16" />
      </span>

      <div class="content" :class="item.type">{{ item.message }}</div>

      <button class="close" @click="notify.close(item.id)">
        <X :size="16" />
      </button>
    </div>
  </div>
</template>


<style scoped>
.notify-host {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.notify {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 180px;
  max-width: 400px;
  padding: 12px 14px;
  border-radius: 6px;
  background: var(--color-white);
  color: var(--color-gray-900);
  box-shadow: 0 6px 15px rgb(0 0 0 / 25%);
  font-size: 14px;
}

.notify .icon {
  display: flex;
  align-items: center;
  opacity: 0.85;
}

.notify .content {
  flex: 1;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notify .save {
  border: none;
  background: transparent;
  color: var(--color-gray-900);
  cursor: pointer;
  font-size: 14px;
}
.notify .close:hover {
  color: var(--color-gray-500);
}

.notify.error {
  color: var(--color-red-600);
}
.notify.error .icon {
  color: var(--color-red-600);
}
</style>
