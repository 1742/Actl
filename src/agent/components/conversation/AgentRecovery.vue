<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ServerCog, RefreshCw, FolderOpen } from '@lucide/vue';
import { bridge, type AgentSettings } from '../../../services/bridge';
import { tr } from '../../../i18n';

const props = defineProps<{ error: string; retry: (restart?: boolean) => Promise<void> }>();
const settings = ref<AgentSettings | null>(null);
const port = ref(0);
const busy = ref(false);
const actionError = ref('');
const validPort = computed(
  () => Number.isInteger(port.value) && port.value >= 0 && port.value <= 65535,
);

async function loadSettings() {
  actionError.value = '';
  try {
    settings.value = await bridge.getAgentSettings();
    port.value = settings.value.port;
  } catch (error) {
    actionError.value = tr('dynamic.configurationLoadFailed', { reason: String(error) });
  }
}
onMounted(loadSettings);

async function restart(savePort: boolean) {
  if (busy.value || (savePort && (!settings.value || !validPort.value))) return;
  busy.value = true;
  actionError.value = '';
  try {
    if (savePort && settings.value)
      await bridge.saveAgentSettings({ ...settings.value, port: port.value });
    await props.retry(true);
  } catch (error) {
    actionError.value = String(error);
  } finally {
    busy.value = false;
  }
}
async function openLogs() {
  try {
    await bridge.openAgentDirectory('logs');
  } catch (error) {
    actionError.value = String(error);
  }
}
</script>

<template>
  <div class="flex h-full w-full items-center justify-center overflow-y-auto bg-gray-50 p-6">
    <section
      class="my-auto w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <div
        class="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-50 text-amber-700"
      >
        <ServerCog :size="24" />
      </div>
      <h1 class="text-xl font-semibold text-gray-900">{{ $t('ui.cannotConnectToLocalAgent') }}</h1>
      <p class="mt-2 text-sm leading-6 text-gray-500">
        {{ $t('ui.checkTheStartupErrorOrChange') }}
      </p>
      <div
        role="alert"
        class="mt-5 max-h-36 overflow-auto break-words rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800"
      >
        {{ error }}
      </div>
      <form class="mt-6" @submit.prevent="restart(true)">
        <label for="recovery-port" class="mb-2 block text-sm font-medium text-gray-700">{{
          $t('ui.agentPort')
        }}</label>
        <input
          id="recovery-port"
          v-model.number="port"
          type="number"
          min="0"
          max="65535"
          step="1"
          :disabled="!settings || busy"
          class="h-11 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 disabled:bg-gray-50 disabled:text-gray-400"
        />
        <p class="mt-2 text-xs text-gray-500">{{ $t('ui.use0ForAnAutomaticallyAssigned') }}</p>
        <p v-if="!validPort" class="mt-2 text-xs text-red-600">
          {{ $t('ui.enterAnIntegerBetween0And') }}
        </p>
        <p v-if="actionError" role="alert" class="mt-3 break-words text-sm text-red-600">
          {{ actionError }}
        </p>
        <div class="mt-6 flex flex-wrap gap-2">
          <button
            type="submit"
            :disabled="!settings || !validPort || busy"
            class="rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {{ $t('ui.savePortAndRestart') }}
          </button>
          <button
            type="button"
            :disabled="busy"
            class="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm text-gray-700 disabled:opacity-40"
            @click="restart(false)"
          >
            <RefreshCw :size="15" />{{ $t('ui.restartAgent') }}
          </button>
        </div>
      </form>
      <div class="mt-6 flex gap-4 border-t border-gray-100 pt-4 text-xs text-gray-500">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 hover:text-gray-900"
          @click="openLogs"
        >
          <FolderOpen :size="14" />{{ $t('ui.openLogFolder') }}
        </button>
        <button v-if="!settings" type="button" class="underline" @click="loadSettings">
          {{ $t('ui.reloadSettings') }}
        </button>
      </div>
    </section>
  </div>
</template>
