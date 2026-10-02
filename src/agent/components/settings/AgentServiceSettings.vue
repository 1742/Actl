<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onMounted, ref } from 'vue';
import { ExternalLink } from '@lucide/vue';
import { bridge, type AgentSettings } from '../../../services/bridge';
import { useNotifyStore } from '../../../composables/notify';
import { useRuntimeStore } from '../../../stores/runtime';
import { useAgentStore } from '../../stores/agent';
import { ensureAgentRuntimeReady } from '../../services/runtimeUsecase';
import {
  initAgentSession,
  loadAgentModels,
  restoreInitialAgentView,
} from '../../composables/useAgent';

const store = useAgentStore();
const notify = useNotifyStore();
const runtime = useRuntimeStore();
const settings = ref<AgentSettings>({ port: 0, storageDirectory: '' });
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const locked = computed(
  () => busy.value || store.hasActiveResponse || store.runtimeAvailability.local === 'checking',
);
const valid = computed(
  () =>
    Number.isInteger(settings.value.port) &&
    settings.value.port >= 0 &&
    settings.value.port <= 65535 &&
    !!settings.value.storageDirectory.trim(),
);
const directoryLinks = computed(
  () =>
    [
      {
        kind: 'storage',
        label: tr('ui.dataFolder'),
        description: tr('ui.viewWhereConversationsAndLocalData'),
      },
      { kind: 'logs', label: tr('ui.logFolder'), description: tr('ui.viewAgentLogs') },
      {
        kind: 'skills',
        label: tr('ui.skillsFolder'),
        description: tr('ui.viewInstalledSkillFiles'),
      },
      {
        kind: 'config',
        label: tr('ui.configurationFile'),
        description: tr('ui.viewTheDesktopAppConfigurationFile'),
      },
    ] as const,
);
async function load() {
  try {
    settings.value = await bridge.getAgentSettings();
    loaded.value = true;
    error.value = '';
  } catch (e) {
    error.value = String(e);
  }
}
onMounted(load);
async function pick() {
  try {
    const path = await bridge.pickDirectory();
    if (path) settings.value.storageDirectory = path;
  } catch (e) {
    notify.error(String(e));
  }
}
async function open(kind: 'storage' | 'logs' | 'skills' | 'config') {
  try {
    await bridge.openAgentDirectory(kind);
  } catch (e) {
    notify.error(String(e));
  }
}
async function save(restart: boolean) {
  if (locked.value || !valid.value || !loaded.value) return;
  busy.value = true;
  let restarting = false;
  try {
    await bridge.saveAgentSettings({
      port: settings.value.port,
      storageDirectory: settings.value.storageDirectory.trim(),
    });
    if (restart) {
      restarting = true;
      store.$reset();
      store.setRuntimeAvailability('local', 'checking');
      runtime.apply(await bridge.restartAgent());
      await ensureAgentRuntimeReady();
      const result = await initAgentSession('local');
      if (result.status === 'error') throw new Error(result.message);
      const restored = await restoreInitialAgentView();
      if (restored.status === 'error')
        notify.error(restored.message || tr('ui.failedToRestoreConversation'));
      const models = await loadAgentModels();
      if (models.status === 'error') notify.error(models.message || tr('ui.failedToLoadModels'));
    }
    notify.success(
      restart
        ? tr('ui.configurationSavedAgentRestarted')
        : tr('ui.configurationSavedTakesEffectWhenAgent'),
    );
  } catch (e) {
    if (restarting) store.setRuntimeAvailability('local', 'unavailable', String(e));
    notify.error(String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section>
    <h2 class="mb-4 text-sm font-medium text-gray-900">{{ $t('ui.service') }}</h2>
    <div class="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div
        class="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-4"
      >
        <div class="min-w-0">
          <p class="text-sm font-medium text-gray-900">{{ $t('ui.connectionStatus') }}</p>
          <p class="mt-1 break-all text-xs text-gray-500">
            {{
              store.runtimeAvailability.local === 'available'
                ? runtime.agentUrl
                : $t('ui.localAgentIsNotConnected')
            }}
          </p>
        </div>
        <span
          class="rounded-full px-2.5 py-1 text-xs"
          :class="
            store.runtimeAvailability.local === 'available'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-gray-100 text-gray-500'
          "
          >{{
            store.runtimeAvailability.local === 'available'
              ? $t('ui.connected')
              : $t('ui.disconnected')
          }}</span
        >
      </div>
      <p v-if="error" class="border-b border-gray-100 px-4 py-3 text-sm text-red-600">
        {{ $t('dynamic.configurationLoadFailed', { reason: error }) }}
        <button class="underline" @click="load">{{ $t('ui.retry') }}</button>
      </p>
      <fieldset :disabled="!loaded || locked" class="disabled:opacity-50">
        <div class="settings-row">
          <div class="min-w-0 flex-1">
            <label for="agent-port" class="text-sm font-medium text-gray-900">{{
              $t('ui.listeningPort')
            }}</label>
            <p class="mt-1 text-xs leading-5 text-gray-500">
              {{ $t('ui.use0ForAnAutomaticallyAssigned2') }}
            </p>
          </div>
          <input
            id="agent-port"
            v-model.number="settings.port"
            type="number"
            min="0"
            max="65535"
            step="1"
            class="h-9 w-28 rounded-lg border border-gray-300 px-3 text-right text-sm"
          />
        </div>
        <div class="settings-row">
          <div class="min-w-0 flex-1">
            <label for="agent-storage" class="text-sm font-medium text-gray-900">{{
              $t('ui.dataFolder')
            }}</label>
            <p class="mt-1 text-xs leading-5 text-gray-500">
              {{ $t('ui.whereConversationsLogsAndSkillsAre') }}
            </p>
          </div>
          <div class="flex w-full min-w-0 gap-2 sm:w-auto sm:max-w-[55%]">
            <input
              id="agent-storage"
              v-model="settings.storageDirectory"
              class="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-3 text-xs"
            />
            <button
              type="button"
              class="shrink-0 rounded-lg border border-gray-200 px-3 text-xs hover:bg-gray-50"
              @click="pick"
            >
              {{ $t('ui.change') }}
            </button>
          </div>
        </div>
      </fieldset>
      <div
        class="flex flex-wrap items-center justify-between gap-4 border-t border-gray-100 px-4 py-4"
      >
        <p class="min-w-0 flex-1 text-xs leading-5 text-gray-500">
          {{ $t('ui.saveToApplyOnTheNext') }}
        </p>
        <div class="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            class="rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-40"
            :disabled="!loaded || locked || !valid"
            @click="save(false)"
          >
            {{ $t('ui.save') }}
          </button>
          <button
            type="button"
            class="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white disabled:opacity-40"
            :disabled="!loaded || locked || !valid"
            @click="save(true)"
          >
            {{ busy ? $t('ui.processing') : $t('ui.saveAndRestartAgent') }}
          </button>
        </div>
      </div>
    </div>

    <h2 class="mb-4 mt-10 text-sm font-medium text-gray-900">{{ $t('ui.fileLocations') }}</h2>
    <div class="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div v-for="item in directoryLinks" :key="item.kind" class="settings-row">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-900">{{ item.label }}</p>
          <p class="mt-1 text-xs leading-5 text-gray-500">{{ item.description }}</p>
        </div>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-40"
          :title="$t('dynamic.openNamed', { name: item.label })"
          :aria-label="$t('dynamic.openNamed', { name: item.label })"
          :disabled="!loaded"
          @click="open(item.kind)"
        >
          <ExternalLink :size="16" />
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";
.settings-row {
  @apply flex flex-wrap items-center justify-between gap-4 border-b border-gray-100 px-4 py-4 last:border-b-0;
}
</style>
