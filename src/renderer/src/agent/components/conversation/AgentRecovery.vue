<script setup lang="ts">
import { ref } from 'vue';
import { RefreshCw, FolderOpen } from '@lucide/vue';
import { bridge } from '../../../services/bridge';
const props = defineProps<{ error: string; retry: (restart?: boolean) => Promise<void> }>();
const busy = ref(false);
const actionError = ref('');
async function restart() {
  if (busy.value) return;
  busy.value = true; actionError.value = '';
  try { await props.retry(true); } catch (error) { actionError.value = String(error); }
  finally { busy.value = false; }
}
async function openLogs() {
  try { await bridge.openAgentDirectory('logs'); } catch (error) { actionError.value = String(error); }
}
</script>
<template>
  <div class="flex h-full w-full items-center justify-center overflow-y-auto bg-gray-50 p-6">
    <section class="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
      <h1 class="text-xl font-semibold text-gray-900">{{ $t('ui.agentRuntimeFailedToStart') }}</h1>
      <p role="alert" class="my-5 wrap-break-word rounded-lg bg-amber-50 p-4 text-sm text-amber-800">{{ error }}</p>
      <p v-if="actionError" role="alert" class="mb-4 text-sm text-red-600">{{ actionError }}</p>
      <div class="flex gap-3">
        <button :disabled="busy" class="flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-40" @click="restart">
          <RefreshCw :size="15" />{{ $t('ui.restartAgent') }}
        </button>
        <button class="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm" @click="openLogs">
          <FolderOpen :size="15" />{{ $t('ui.openLogFolder') }}
        </button>
      </div>
    </section>
  </div>
</template>
