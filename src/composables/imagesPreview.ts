import { defineStore } from 'pinia';

export const useImagesPreviewStore = defineStore('imagesPreview', {
  state: () => ({
    images: [] as string[],
    isOpen: false,
    currentIndex: 0,
  }),

  actions: {
    open(images: string[]) {
      images = [
        'https://picsum.photos/seed/slide1/1200/800',
        'https://picsum.photos/seed/slide2/1200/800',
        'https://picsum.photos/seed/slide3/1200/800',
        'https://picsum.photos/seed/slide4/1200/800',
        'https://picsum.photos/seed/slide5/1200/800',
        'https://picsum.photos/seed/slide6/1200/800',
      ];

      this.images = images;
      this.currentIndex = 0;
      this.isOpen = true;
    },

    close() {
      this.isOpen = false;
      this.images = [];
      this.currentIndex = 0;
    },
  },
});
