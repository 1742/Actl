<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { useImagesPreviewStore } from '../composables/imagesPreview';

const emit = defineEmits<{
  close: [];
}>();

const store = useImagesPreviewStore();

const imgUrls = computed(() => store.images);
const currentIndex = ref(0);
const isFullscreen = ref(false);

const close = () => {
  store.close();
  emit('close');
};

const nextSlide = () => {
  currentIndex.value = (currentIndex.value + 1) % imgUrls.value.length;
};

const prevSlide = () => {
  currentIndex.value = (currentIndex.value - 1 + imgUrls.value.length) % imgUrls.value.length;
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowRight') nextSlide();
  if (event.key === 'ArrowLeft') prevSlide();
  if (event.key === 'Escape' && isFullscreen.value) isFullscreen.value = false;
};

onMounted(() => {
  store.open([]);
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
});
</script>

<template>
  <div
    class="fixed inset-0 z-100 flex flex-col items-center justify-center backdrop-blur-lg transition-all duration-300"
    @click.self="close"
  >
    <main class="flex max-h-screen flex-col items-center justify-center overflow-hidden p-3 md:p-8">
      <!-- Main Slide Container -->
      <div class="preview-stage group relative aspect-video overflow-hidden rounded-2xl shadow-2xl shadow-black/5">
        <!-- Slide Animation -->
        <Transition name="slide-fade" mode="out-in">
          <img
            :key="currentIndex"
            :src="imgUrls[currentIndex]"
            :alt="`Slide ${currentIndex + 1}`"
            class="w-full h-full object-cover"
            referrerpolicy="no-referrer"
            @click="close"
          />
        </Transition>

        <!-- Navigation Controls -->
        <div class="absolute inset-y-0 left-0 flex items-center pl-4 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            class="rounded-full bg-white/80 p-3 shadow-lg backdrop-blur-md transition-all hover:bg-white"
            @click="prevSlide"
          >
            <ChevronLeft :size="24" />
          </button>
        </div>
        <div class="absolute inset-y-0 right-0 flex items-center pr-4 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            class="rounded-full bg-white/80 p-3 shadow-lg backdrop-blur-md transition-all hover:bg-white"
            @click="nextSlide"
          >
            <ChevronRight :size="24" />
          </button>
        </div>

        <!-- Slide Counter -->
        <div class="absolute bottom-4 right-4 rounded-full bg-black/50 px-3 py-1 font-mono text-xs text-white backdrop-blur-md">
          {{ currentIndex + 1 }} / {{ imgUrls.length }}
        </div>
      </div>

      <!-- Thumbnail Strip -->
      <div class="preview-thumbnails no-scrollbar mt-4 flex gap-2 overflow-x-auto px-1 pb-4 pt-4 md:mt-8 md:gap-3 md:px-4">
        <button
          v-for="(url, idx) in imgUrls"
          :key="idx"
          @click="currentIndex = idx"
          :class="[
            'preview-thumb relative aspect-video shrink-0 overflow-hidden rounded-lg border-2 transition-all',
            currentIndex === idx
              ? 'scale-105 border-primary shadow-lg'
              : 'border-transparent opacity-60 hover:opacity-100',
          ]"
        >
          <img
            :src="url"
            :alt="`Thumb ${idx + 1}`"
            class="h-full w-full object-cover"
            referrerpolicy="no-referrer"
          />
          <div class="absolute bottom-1 right-1 rounded bg-black/40 px-1 text-[10px] text-white">
            {{ idx + 1 }}
          </div>
        </button>
      </div>
    </main>
  </div>
</template>


<style scoped>
.preview-stage {
  width: min(56vw, 64rem);
  max-height: min(64vh, calc(100vh - 11rem));
}

.preview-thumbnails {
  width: min(56vw, 64rem);
  max-width: calc(100vw - 1.5rem);
}

.preview-thumb {
  width: 8rem;
}

@media (max-width: 900px) {
  .preview-stage {
    width: min(66vw, 36rem);
    max-height: calc(100vh - 10rem);
  }

  .preview-thumbnails {
    width: min(66vw, 36rem);
    max-width: calc(100vw - 1.5rem);
  }

  .preview-thumb {
    width: 5rem;
  }
}

@media (max-height: 640px) {
  .preview-stage {
    max-height: 50vh;
  }
}

/* 幻灯片切换动画 (对应 React 的 motion) */
.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.4s cubic-bezier(0.25, 0.1, 0.25, 1);
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateX(20px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}
</style>
