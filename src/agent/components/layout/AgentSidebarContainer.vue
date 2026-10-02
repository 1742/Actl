<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();

async function closeRightSidebar() {
  await router.push({ name: "aiAgent" });
}
</script>

<template>
  <router-view v-slot="{ Component }">
    <Transition name="right-sidebar-panel">
      <div v-if="Component" class="right-sidebar-panel h-full min-h-0 overflow-hidden border-l border-gray-200 bg-white">
        <component :is="Component" @close="closeRightSidebar" />
      </div>
    </Transition>
  </router-view>
</template>

<style scoped>
.right-sidebar-panel {
  flex: 0 0 min(30rem, calc(100vw - 2rem));
  transition: flex-basis 0.25s ease, width 0.25s ease;
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
