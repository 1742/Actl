<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Cable, LoaderCircle, Save, Trash2, Zap } from '@lucide/vue';
import { useNotifyStore } from '../../../composables/notify';
import { getAgentRuntimeClient } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimeMcpServer, RuntimeMcpServerConfig } from '../../types';
import { mcpRefreshVersion } from '../layout/libraryNavigation';

const router = useRouter();
const route = useRoute();
const notify = useNotifyStore();
const agentStore = useAgentStore();
const servers = ref<RuntimeMcpServer[]>([]);
const selectedName = ref('');
const editing = ref(false);
const creating = ref(false);
const loading = ref(false);
const busy = ref(false);
const testing = ref(false);
const error = ref('');
const form = ref({ name: '', command: '', args: '', cwd: '', env: '{}', enabled: true });

const available = computed(() => agentStore.runtimeAvailability.local === 'available');
const locked = computed(() => agentStore.hasActiveResponse);
const selected = computed(() => servers.value.find((server) => server.name === selectedName.value));
const nameValid = computed(() => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(form.value.name.trim()));

function client() {
  return getAgentRuntimeClient('local');
}

async function load() {
  if (!available.value) return;
  loading.value = true;
  error.value = '';
  try {
    servers.value = await client().listMcpServers();
    if (
      typeof route.query.server === 'string' &&
      servers.value.some((server) => server.name === route.query.server)
    )
      selectedName.value = route.query.server;
    if (selectedName.value && !servers.value.some((server) => server.name === selectedName.value))
      selectedName.value = '';
    if (!selectedName.value && servers.value.length) selectedName.value = servers.value[0]!.name;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : tr('ui.failedToLoadMcpServer');
  } finally {
    loading.value = false;
  }
}

function fillForm(server?: RuntimeMcpServer) {
  form.value = server
    ? {
        name: server.name,
        command: server.config.command,
        args: server.config.args.join('\n'),
        cwd: server.config.cwd ?? '',
        env: JSON.stringify(server.config.env ?? {}, null, 2),
        enabled: server.config.enabled,
      }
    : { name: '', command: '', args: '', cwd: '', env: '{}', enabled: true };
}

function startCreate() {
  fillForm();
  creating.value = true;
  editing.value = true;
  if (route.query.create !== '1') void router.push({ name: 'aiMcp', query: { create: '1' } });
}

function startEdit() {
  if (!selected.value) return;
  fillForm(selected.value);
  creating.value = false;
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  creating.value = false;
  if (route.query.create === '1')
    void router.push({
      name: 'aiMcp',
      query: selectedName.value ? { server: selectedName.value } : {},
    });
}

function formConfig(): RuntimeMcpServerConfig {
  if (!nameValid.value) throw new Error(tr('ui.nameMustStartWithALetter'));
  if (!form.value.command.trim()) throw new Error(tr('ui.enterALaunchCommand'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(form.value.env || '{}');
  } catch {
    throw new Error(tr('ui.environmentVariablesMustBeAJson'));
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new Error(tr('ui.environmentVariablesMustContainStringPairs'));
  }
  return {
    command: form.value.command.trim(),
    args: form.value.args.split(/\r?\n/).filter((arg) => arg.length > 0),
    ...(form.value.cwd.trim() ? { cwd: form.value.cwd.trim() } : {}),
    ...(Object.keys(parsed).length ? { env: parsed as Record<string, string> } : {}),
    enabled: form.value.enabled,
  };
}

async function save() {
  if (busy.value || locked.value) return;
  try {
    const config = formConfig();
    busy.value = true;
    const name = form.value.name.trim();
    const saved = await client().saveMcpServer(name, config);
    selectedName.value = name;
    editing.value = false;
    creating.value = false;
    await router.replace({ name: 'aiMcp', query: { server: name } });
    await load();
    mcpRefreshVersion.value++;
    if (config.enabled && !saved.connected)
      notify.error(
        tr('dynamic.savedButConnectionFailed', {
          reason: saved.error ?? tr('ui.checkTheLaunchCommandAndArguments'),
        }),
      );
    else notify.success(tr('ui.mcpServerSavedAndApplied'));
  } catch (cause) {
    notify.error(cause instanceof Error ? cause.message : tr('ui.saveFailed'));
  } finally {
    busy.value = false;
  }
}

async function testConnection() {
  if (testing.value) return;
  try {
    const config = formConfig();
    testing.value = true;
    const result = await client().testMcpServer(form.value.name.trim(), config);
    notify.success(tr('dynamic.foundTools', { count: result.tools.length }));
  } catch (cause) {
    notify.error(cause instanceof Error ? cause.message : tr('ui.connectionTestFailed'));
  } finally {
    testing.value = false;
  }
}

async function toggle(server: RuntimeMcpServer) {
  if (busy.value || locked.value) return;
  busy.value = true;
  try {
    const updated = await client().saveMcpServer(server.name, {
      ...server.config,
      enabled: !server.config.enabled,
    });
    await load();
    mcpRefreshVersion.value++;
    if (updated.config.enabled && !updated.connected)
      notify.error(
        tr('dynamic.enabledButConnectionFailed', {
          reason: updated.error ?? tr('ui.checkTheConfiguration'),
        }),
      );
    else
      notify.success(
        server.config.enabled ? tr('ui.mcpServerDisabled') : tr('ui.mcpServerEnabled'),
      );
  } catch (cause) {
    notify.error(cause instanceof Error ? cause.message : tr('ui.operationFailed'));
  } finally {
    busy.value = false;
  }
}

async function remove() {
  const server = selected.value;
  if (
    !server ||
    busy.value ||
    locked.value ||
    !window.confirm(tr('dynamic.deleteMcp', { name: server.name }))
  )
    return;
  busy.value = true;
  try {
    await client().deleteMcpServer(server.name);
    selectedName.value = '';
    await load();
    await router.replace({
      name: 'aiMcp',
      query: selectedName.value ? { server: selectedName.value } : {},
    });
    mcpRefreshVersion.value++;
    notify.success(tr('ui.mcpServerDeleted'));
  } catch (cause) {
    notify.error(cause instanceof Error ? cause.message : tr('ui.deleteFailed'));
  } finally {
    busy.value = false;
  }
}

watch(available, (value) => {
  if (value) void load();
});
watch(
  () => [route.query.server, route.query.create],
  () => {
    if (route.query.create === '1') {
      if (!creating.value) startCreate();
      return;
    }
    if (typeof route.query.server === 'string') {
      selectedName.value = route.query.server;
      editing.value = false;
      creating.value = false;
    }
  },
  { immediate: true },
);
watch(mcpRefreshVersion, () => {
  void load();
});
onMounted(() => {
  void load();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden bg-white">
    <div
      v-if="!available"
      class="flex flex-1 items-center justify-center p-8 text-sm text-gray-500"
    >
      {{ $t('ui.localAgentRuntimeIsCurrentlyUnavailable') }}
    </div>
    <div
      v-else-if="error"
      class="mx-auto mt-8 max-w-xl rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800"
    >
      {{ error }}
    </div>
    <div
      v-else-if="loading && !servers.length && !editing"
      class="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500"
    >
      <LoaderCircle :size="16" class="animate-spin" />{{ $t('ui.loadingMcpServer') }}
    </div>
    <main v-else class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-5xl px-6 py-8 sm:px-8">
        <form v-if="editing" class="space-y-5" @submit.prevent="save">
          <div class="mb-8 flex items-center justify-between gap-4">
            <h1 class="font-mono text-2xl font-semibold tracking-tight text-gray-900">
              {{ creating ? $t('ui.addServer') : selectedName }}
            </h1>
            <button
              type="button"
              class="text-sm text-gray-500 hover:text-gray-900"
              @click="cancelEdit"
            >
              {{ $t('ui.cancel') }}
            </button>
          </div>
          <label class="block text-sm font-medium text-gray-700"
            >{{ $t('ui.name')
            }}<input
              v-model="form.name"
              :disabled="!creating"
              class="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 outline-none focus:border-gray-500 disabled:bg-gray-50"
              :placeholder="$t('ui.forExampleFilesystem')"
          /></label>
          <label class="block text-sm font-medium text-gray-700"
            >{{ $t('ui.launchCommand')
            }}<input
              v-model="form.command"
              class="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs outline-none focus:border-gray-500"
              :placeholder="$t('ui.forExampleCProgramFilesNodejs')"
          /></label>
          <label class="block text-sm font-medium text-gray-700"
            >{{ $t('ui.arguments') }}
            <span class="font-normal text-gray-400">{{ $t('ui.onePerLine') }}</span
            ><textarea
              v-model="form.args"
              rows="4"
              class="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs outline-none focus:border-gray-500"
              placeholder="server.js&#10;D:\workspace"
            />
          </label>
          <label class="block text-sm font-medium text-gray-700"
            >{{ $t('ui.workingDirectory') }}
            <span class="font-normal text-gray-400">{{ $t('ui.optional') }}</span
            ><input
              v-model="form.cwd"
              class="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs outline-none focus:border-gray-500"
          /></label>
          <label class="block text-sm font-medium text-gray-700"
            >{{ $t('ui.environmentVariables') }}
            <span class="font-normal text-gray-400">{{ $t('ui.jsonObjectOptional') }}</span
            ><textarea
              v-model="form.env"
              rows="3"
              class="mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs outline-none focus:border-gray-500"
            />
          </label>
          <p class="text-xs text-amber-700">{{ $t('ui.mcpConfigurationIsStoredInThe') }}</p>
          <label class="flex items-center gap-2 text-sm text-gray-700"
            ><input v-model="form.enabled" type="checkbox" class="accent-gray-900" />{{
              $t('ui.enableServer')
            }}</label
          >
          <p v-if="locked" class="text-xs text-amber-700">
            {{ $t('ui.mcpConfigurationCannotBeChangedWhile') }}
          </p>
          <div class="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 disabled:opacity-40"
              :disabled="testing || busy"
              @click="testConnection"
            >
              <Zap :size="15" />{{ testing ? $t('ui.connecting') : $t('ui.testConnection') }}
            </button>
            <button
              type="submit"
              class="flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              :disabled="busy || testing || locked"
            >
              <Save :size="15" />{{ busy ? $t('ui.saving') : $t('ui.saveAndApply') }}
            </button>
          </div>
        </form>

        <section v-else-if="selected">
          <div class="flex flex-wrap items-center gap-3">
            <h1
              class="min-w-0 break-all font-mono text-2xl font-semibold tracking-tight text-gray-900"
            >
              {{ selected.name }}
            </h1>
            <span
              class="rounded-md px-2 py-1 text-xs"
              :class="
                selected.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
              "
              >{{
                selected.connected
                  ? $t('ui.connected')
                  : selected.config.enabled
                    ? $t('ui.disconnected')
                    : $t('ui.disabled')
              }}</span
            >
          </div>
          <p class="mt-5 break-all font-mono text-sm leading-6 text-gray-600">
            {{ selected.config.command }}
          </p>
          <p v-if="selected.error" class="mt-5 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {{ selected.error }}
          </p>
          <div class="mt-6 flex flex-wrap gap-2">
            <button
              class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-40"
              :disabled="busy || locked"
              @click="startEdit"
            >
              {{ $t('ui.edit') }}
            </button>
            <button
              class="rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium hover:bg-gray-50 disabled:opacity-40"
              :disabled="busy || locked"
              @click="toggle(selected)"
            >
              {{ selected.config.enabled ? $t('ui.disable') : $t('ui.enable') }}
            </button>
            <button
              class="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
              :disabled="busy || locked"
              @click="remove"
            >
              <Trash2 :size="14" />{{ $t('ui.delete') }}
            </button>
          </div>
          <h2 class="mt-10 text-base font-semibold text-gray-900">{{ $t('ui.configuration') }}</h2>
          <dl class="mt-4 overflow-hidden rounded-xl border border-gray-200 text-sm">
            <div class="flex flex-wrap gap-x-6 gap-y-1 border-b border-gray-100 px-4 py-3">
              <dt class="w-20 shrink-0 text-gray-500">{{ $t('ui.launchCommand') }}</dt>
              <dd class="min-w-0 flex-1 break-all font-mono text-xs text-gray-800">
                {{ selected.config.command }}
              </dd>
            </div>
            <div class="flex flex-wrap gap-x-6 gap-y-1 border-b border-gray-100 px-4 py-3">
              <dt class="w-20 shrink-0 text-gray-500">{{ $t('ui.arguments') }}</dt>
              <dd class="min-w-0 flex-1 break-all font-mono text-xs text-gray-800">
                {{ selected.config.args.join(' ') || '—' }}
              </dd>
            </div>
            <div class="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3">
              <dt class="w-20 shrink-0 text-gray-500">{{ $t('ui.workingDirectory') }}</dt>
              <dd class="min-w-0 flex-1 break-all font-mono text-xs text-gray-800">
                {{ selected.config.cwd || '—' }}
              </dd>
            </div>
          </dl>
          <h2 class="mt-8 text-base font-semibold text-gray-900">
            {{ $t('ui.toolsHeading') }} {{ selected.tools.length }}
          </h2>
          <p v-if="!selected.tools.length" class="mt-4 text-sm text-gray-500">
            {{
              selected.config.enabled
                ? $t('ui.noToolsFoundRefreshTheList')
                : $t('ui.enableThisServerToDiscoverIts')
            }}
          </p>
          <div
            v-else
            class="mt-4 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200"
          >
            <div v-for="tool in selected.tools" :key="tool.name" class="px-4 py-3">
              <code class="break-all text-xs font-medium text-gray-800">{{ tool.name }}</code>
              <p class="mt-1 text-xs leading-5 text-gray-500">{{ tool.description }}</p>
            </div>
          </div>
        </section>
        <div
          v-else
          class="flex h-64 flex-col items-center justify-center gap-3 text-sm text-gray-500"
        >
          <Cable :size="28" class="text-gray-300" />
          <p>{{ $t('ui.selectAServerOrAddA') }}</p>
        </div>
      </div>
    </main>
  </div>
</template>
