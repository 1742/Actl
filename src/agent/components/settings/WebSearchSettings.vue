<script setup lang="ts">
import { tr } from '../../../i18n';
import { Eye, EyeOff, KeyRound, LoaderCircle, Trash2 } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useNotifyStore } from '../../../composables/notify';
import { getAgentRuntimeClient } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimeWebSearchSettings } from '../../types';

const DEFAULT_BASE_URLS: Record<RuntimeWebSearchSettings['provider'], string> = {
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  serper: 'https://google.serper.dev/search',
  bocha: 'https://api.bocha.cn/v1/web-search',
};
const store = useAgentStore();
const notify = useNotifyStore();
const enabled = ref(false);
const mode = ref<RuntimeWebSearchSettings['mode']>('auto');
const provider = ref<RuntimeWebSearchSettings['provider']>('brave');
const baseUrl = ref(DEFAULT_BASE_URLS.brave);
const apiKey = ref('');
const hasCredential = ref(false);
const showApiKey = ref(false);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const locked = computed(() => store.hasActiveResponse);
const usesExternalSearch = computed(() => mode.value !== 'native');
const canSave = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !locked.value &&
    (!usesExternalSearch.value || Boolean(baseUrl.value.trim())) &&
    (!enabled.value ||
      mode.value !== 'external' ||
      hasCredential.value ||
      Boolean(apiKey.value.trim())),
);

function client() {
  return getAgentRuntimeClient(store.runtimeKind);
}

async function load() {
  loading.value = true;
  try {
    const settings = await client().getWebSearchSettings();
    enabled.value = settings.enabled;
    provider.value = settings.provider;
    mode.value = settings.mode;
    baseUrl.value = settings.baseUrl;
    hasCredential.value = settings.hasCredential;
  } catch (error) {
    notify.error(
      error instanceof Error ? error.message : tr('ui.failedToLoadWebSearchConfiguration'),
    );
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const settings = await client().saveWebSearchSettings({
      enabled: enabled.value,
      provider: provider.value,
      mode: mode.value,
      ...(usesExternalSearch.value ? { baseUrl: baseUrl.value.trim() } : {}),
      ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    });
    enabled.value = settings.enabled;
    provider.value = settings.provider;
    mode.value = settings.mode;
    baseUrl.value = settings.baseUrl;
    hasCredential.value = settings.hasCredential;
    apiKey.value = '';
    showApiKey.value = false;
    notify.success(tr('ui.webSearchConfigurationSaved'));
  } catch (error) {
    notify.error(
      error instanceof Error ? error.message : tr('ui.failedToSaveWebSearchConfiguration'),
    );
  } finally {
    saving.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  try {
    const result = await client().testWebSearch();
    notify.success(tr('dynamic.searchResultCount', { count: result.results.length }));
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.searchConnectionTestFailed'));
  } finally {
    testing.value = false;
  }
}

async function clearCredential() {
  try {
    const settings = await client().clearWebSearchCredential();
    enabled.value = settings.enabled;
    mode.value = settings.mode;
    baseUrl.value = settings.baseUrl;
    hasCredential.value = settings.hasCredential;
    apiKey.value = '';
    notify.success(
      mode.value === 'external'
        ? tr('ui.searchApiKeyClearedWebSearch')
        : tr('ui.externalSearchApiKeyCleared'),
    );
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToClearSearchApiKey'));
  }
}

onMounted(load);

function selectProvider() {
  baseUrl.value = DEFAULT_BASE_URLS[provider.value];
  apiKey.value = '';
  hasCredential.value = false;
}
</script>

<template>
  <section>
    <h2 class="mb-4 text-sm font-medium text-gray-900">{{ $t('ui.searchService') }}</h2>
    <div class="overflow-hidden rounded-2xl border border-gray-200 bg-white">
      <div class="settings-row">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-gray-900">{{ $t('ui.enableWebSearch') }}</p>
          <p class="mt-1 text-xs leading-5 text-gray-500">
            {{ $t('ui.preferNativeSearchFromTheModel') }}
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2 text-sm text-gray-700">
          <input
            v-model="enabled"
            type="checkbox"
            class="search-toggle"
            :disabled="loading || locked"
          />
          {{ $t('ui.enable') }}
        </label>
      </div>

      <div
        v-if="loading"
        class="flex items-center gap-2 border-b border-gray-100 px-4 py-5 text-sm text-gray-500"
      >
        <LoaderCircle :size="16" class="animate-spin" />{{ $t('ui.loadingConfiguration') }}
      </div>
      <template v-else>
        <div class="settings-row">
          <div class="min-w-0 flex-1">
            <label for="search-mode" class="text-sm font-medium text-gray-900">{{
              $t('ui.searchMode')
            }}</label>
            <p class="mt-1 text-xs leading-5 text-gray-500">
              {{ $t('ui.chooseWhenToUseAnExternal') }}
            </p>
          </div>
          <select
            id="search-mode"
            v-model="mode"
            class="field-input w-full bg-white sm:w-80"
            :disabled="locked"
          >
            <option value="auto">{{ $t('ui.automaticPreferNativeSearch') }}</option>
            <option value="native">{{ $t('ui.useOnlyProviderNativeSearch') }}</option>
            <option value="external">{{ $t('ui.alwaysUseExternalSearch') }}</option>
          </select>
        </div>
        <template v-if="usesExternalSearch">
          <div class="settings-row">
            <label for="search-provider" class="min-w-0 flex-1 text-sm font-medium text-gray-900">{{
              $t('ui.externalSearchProvider')
            }}</label>
            <select
              id="search-provider"
              v-model="provider"
              class="field-input w-full bg-white sm:w-80"
              :disabled="locked"
              @change="selectProvider"
            >
              <option value="brave">Brave Search</option>
              <option value="tavily">Tavily</option>
              <option value="serper">Serper（Google）</option>
              <option value="bocha">{{ $t('ui.bocha') }}</option>
            </select>
          </div>
          <div class="settings-row">
            <label for="search-url" class="min-w-0 flex-1 text-sm font-medium text-gray-900">{{
              $t('ui.apiEndpoint')
            }}</label>
            <input
              id="search-url"
              v-model="baseUrl"
              class="field-input w-full sm:w-80"
              :disabled="locked"
            />
          </div>
          <div class="settings-row">
            <div class="min-w-0 flex-1">
              <label for="search-key" class="text-sm font-medium text-gray-900"
                >{{
                  provider === 'brave'
                    ? 'Brave Search'
                    : provider === 'tavily'
                      ? 'Tavily'
                      : provider === 'serper'
                        ? 'Serper'
                        : $t('ui.bocha')
                }}
                API Key</label
              >
              <p class="mt-1 text-xs leading-5 text-gray-500">
                {{
                  hasCredential
                    ? $t('ui.storedSecurelyLeaveBlankToKeep')
                    : $t('ui.usedToCallTheExternalSearch')
                }}
              </p>
            </div>
            <span class="relative block w-full sm:w-80">
              <input
                id="search-key"
                v-model="apiKey"
                class="secret-input field-input w-full pr-11"
                :type="showApiKey ? 'text' : 'password'"
                autocomplete="new-password"
                :placeholder="hasCredential ? $t('ui.configured') : $t('ui.enterAnApiKey')"
                :disabled="locked"
              />
              <button
                class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-400"
                type="button"
                :disabled="locked"
                :aria-label="showApiKey ? $t('ui.hideApiKey') : $t('ui.showApiKey')"
                @click="showApiKey = !showApiKey"
              >
                <EyeOff v-if="showApiKey" :size="16" /><Eye v-else :size="16" />
              </button>
            </span>
          </div>
        </template>
        <p v-else class="border-b border-gray-100 px-4 py-4 text-xs leading-5 text-gray-500">
          {{ $t('ui.nativeSearchUsesYourCurrentModel') }}
        </p>
      </template>
      <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <span
          v-if="usesExternalSearch"
          class="inline-flex items-center gap-1.5 text-xs"
          :class="hasCredential ? 'text-emerald-700' : 'text-gray-500'"
        >
          <KeyRound :size="14" />
          {{
            hasCredential
              ? $t('ui.configured')
              : mode === 'auto'
                ? $t('ui.notConfigured')
                : $t('ui.apiKeyNotConfigured')
          }}
        </span>
        <span v-else class="text-xs text-gray-500">{{ $t('ui.useModelProviderCredentials') }}</span>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="usesExternalSearch && hasCredential"
            class="danger-button"
            type="button"
            :disabled="locked"
            @click="clearCredential"
          >
            <Trash2 :size="14" /> {{ $t('ui.clearKey') }}
          </button>
          <button
            v-if="usesExternalSearch"
            class="secondary-button"
            type="button"
            :disabled="!hasCredential || testing || locked"
            @click="testConnection"
          >
            <LoaderCircle v-if="testing" :size="14" class="animate-spin" />
            {{ testing ? $t('ui.testing') : $t('ui.testConnection') }}
          </button>
          <button class="primary-button" type="button" :disabled="!canSave" @click="save">
            {{ saving ? $t('ui.saving') : $t('ui.save') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";
.field-label {
  @apply mb-1.5 block text-sm font-medium text-gray-700;
}
.field-input {
  @apply h-10 rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-100 disabled:bg-gray-100 disabled:text-gray-500;
}
.settings-row {
  @apply flex flex-wrap items-center justify-between gap-4 border-b border-gray-100 px-4 py-4 last:border-b-0;
}
.search-toggle {
  @apply relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-gray-200 transition-colors checked:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50;
}
.search-toggle::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px #0002;
  content: '';
  transition: transform 0.15s;
}
.search-toggle:checked::after {
  transform: translateX(16px);
}
.secret-input::-ms-reveal,
.secret-input::-ms-clear {
  display: none;
}
.secondary-button {
  @apply inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40;
}
.danger-button {
  @apply inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-40;
}
.primary-button {
  @apply inline-flex h-9 items-center justify-center rounded-lg bg-gray-900 px-4 text-sm font-medium text-white disabled:opacity-40;
}
</style>
