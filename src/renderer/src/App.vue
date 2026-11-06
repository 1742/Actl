<script setup lang="ts">
import { computed } from 'vue';
import ImagesPreview from './components/ImagesPreview.vue';
import Notify from './components/Notify.vue';

import { useImagesPreviewStore } from './composables/imagesPreview';

const isOpenImagesPreview = computed(() => useImagesPreviewStore().isOpen);
</script>

<template>
  <div class="flex h-screen w-screen overflow-hidden bg-white text-slate-900">
    <!-- 主区域 -->
    <main class="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <!-- 路由出口 -->
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <!-- 全局组件 -->
    <Notify />
    <Teleport to="body">
      <Transition name="fade-overlay">
        <ImagesPreview v-if="isOpenImagesPreview" />
      </Transition>
    </Teleport>
  </div>
</template>


<style>
/* 进入退出动画 */
.fade-overlay-enter-active,
.fade-overlay-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.fade-overlay-enter-from,
.fade-overlay-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
