import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'runtime-worker': resolve('src/runtime/worker.ts'),
          'agent-worker': resolve('src/runtime/agent-worker.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs',
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: { plugins: [vue(), tailwindcss()] },
});
