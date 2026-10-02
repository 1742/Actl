import { defineStore } from 'pinia';

type NotifyType = 'success' | 'error' | 'info' | 'loading';

interface NotifyItem {
  id: number;
  type: NotifyType;
  message: string;
  duration?: number; // ms
}


let seed = 0;

export const useNotifyStore = defineStore('notify', {
  state: () => ({
    items: [] as NotifyItem[],
  }),

  actions: {
    open(type: NotifyType, message: string, duration?: number) {
      const id = ++seed;

      const item: NotifyItem = {
        id,
        type,
        message,
        duration,
      };

      if (this.items.length >= 3) {
        this.items.splice(0, 1);
      }

      this.items.push(item);

      if (item.duration) {
        setTimeout(() => this.close(id), item.duration);
      }

      return id;
    },

    success(message: string, duration = 4000) {
      return this.open('success', message, duration);
    },

    error(message: string, duration = 4000) {
      return this.open('error', message, duration);
    },

    info(message: string, duration = 4000) {
      return this.open('info', message, duration);
    },

    loading(message: string, duration = 6000) {
      return this.open('loading', message, duration);
    },

    display(status: string, message?: string, duration = 4000) {
      if (!message) return;

      if (status === 'success') return this.success(message, duration);
      if (status === 'error') return this.error(message, duration);
      if (status === 'info') return this.info(message, duration);
      if (status === 'loading') return this.loading(message, duration);
    },

    close(id: number) {
      const index = this.items.findIndex((item) => item.id === id);
      if (index !== -1) this.items.splice(index, 1);
    },

    clear() {
      this.items.length = 0;
    },
  },
});
