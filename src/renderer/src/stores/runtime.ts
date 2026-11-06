import { defineStore } from 'pinia';

import type { RuntimeConfig } from '../types/common';

export const useRuntimeStore = defineStore('runtimeConfig', {
  state: () => ({
    isReady: false,
    primaryColor: '#2a2a2a',
    primaryForeColor: '#ffffff',
    agentUrl: '',
    agentToken: '',
  }),

  getters: {
    aiBackend: () => 'agent-runtime' as const,
  },

  actions: {
    apply(config: RuntimeConfig) {
      this.agentUrl = config.agentUrl;
      this.agentToken = config.agentToken;
      this.isReady = true;
    },

    markReady() {
      this.isReady = true;
    },
  },
});
