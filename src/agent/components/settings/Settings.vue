<script setup lang="ts">
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  ServerCog,
  Moon,
  Sun,
  Trash2,
  X,
} from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useNotifyStore } from '../../../composables/notify';
import { setTheme, theme } from '../../../composables/theme';
import { languageMode, setLanguageMode, tr } from '../../../i18n';
import { useAgentStore } from '../../stores/agent';
import AgentServiceSettings from './AgentServiceSettings.vue';
import WebSearchSettings from './WebSearchSettings.vue';
import PromptSettings from './PromptSettings.vue';
import type {
  RuntimeModel,
  RuntimeModelCapabilities,
  RuntimeModelConfig,
  RuntimeModelProtocol,
} from '../../types';
import {
  loadAgentModels,
  removeAgentModel,
  removeAgentProvider,
  saveAgentModel,
  saveAgentProvider,
  selectAgentModel,
  updateAgentModel,
  updateAgentProvider,
} from '../../composables/useAgent';

const store = useAgentStore();
const notify = useNotifyStore();
const route = useRoute();
const activeSection = computed(() =>
  ['agent', 'appearance', 'prompts', 'search', 'models'].includes(String(route.query.section))
    ? String(route.query.section)
    : 'agent',
);
const sectionTitle = computed(() => tr(`settings.sections.${activeSection.value}`));
const expanded = ref<Record<string, boolean>>({});
const providerFormOpen = ref(false);
const editingProviderAccountId = ref('');
const modelAccountId = ref('');
const editingModelTargetId = ref('');
const accountName = ref('');
const baseURL = ref('https://api.openai.com/v1');
const apiKey = ref('');
const showApiKey = ref(false);
const modelName = ref('');
const modelDisplayName = ref('');
const modelProtocol = ref<RuntimeModelProtocol>('responses');
const modelCapabilities = ref<RuntimeModelCapabilities>(createDefaultModelCapabilities());
const modelSupportsImage = ref(false);
const modelSupportsAudio = ref(false);
const imageMimeTypesText = ref('');
const audioMimeTypesText = ref('');
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const saving = ref(false);
const deleteModelTarget = ref('');
const deleteAccountTarget = ref('');
const deleting = ref(false);
const configurationLocked = computed(() => store.hasActiveResponse);
const canSaveProvider = computed(() =>
  Boolean(
    (editingProviderAccountId.value || apiKey.value.trim()) &&
    accountName.value.trim() &&
    baseURL.value.trim() &&
    !saving.value &&
    !configurationLocked.value,
  ),
);
const canSaveModel = computed(() =>
  Boolean(
    modelAccountId.value && modelName.value.trim() && !saving.value && !configurationLocked.value,
  ),
);

const modelsFor = (accountId: string) =>
  store.models.filter((item) => item.providerAccountId === accountId);
const toggle = (key: string) => {
  expanded.value[key] = !expanded.value[key];
};

const DEFAULT_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const DEFAULT_AUDIO_MIME_TYPES = ['audio/*'];

function createDefaultModelCapabilities(): RuntimeModelCapabilities {
  return {
    input: { text: true, imageMimeTypes: [], audioMimeTypes: [] },
    toolCalling: true,
    parallelToolCalls: true,
    nativeWebSearch: false,
    reasoningEfforts: [],
  };
}

function cloneModelCapabilities(capabilities: RuntimeModelCapabilities): RuntimeModelCapabilities {
  return {
    ...capabilities,
    input: {
      ...capabilities.input,
      imageMimeTypes: [...capabilities.input.imageMimeTypes],
      audioMimeTypes: [...capabilities.input.audioMimeTypes],
    },
    reasoningEfforts: [...capabilities.reasoningEfforts],
  };
}

function resetModelModalities(capabilities: RuntimeModelCapabilities) {
  modelCapabilities.value = cloneModelCapabilities(capabilities);
  modelSupportsImage.value = capabilities.input.imageMimeTypes.length > 0;
  modelSupportsAudio.value = capabilities.input.audioMimeTypes.length > 0;
  imageMimeTypesText.value = capabilities.input.imageMimeTypes.join(', ');
  audioMimeTypesText.value = capabilities.input.audioMimeTypes.join(', ');
}

function selectedModelCapabilities(): RuntimeModelCapabilities {
  const capabilities = modelCapabilities.value;
  const selected: RuntimeModelCapabilities = {
    ...cloneModelCapabilities(capabilities),
    nativeWebSearch: modelProtocol.value === 'responses' && capabilities.nativeWebSearch,
    input: {
      text: true,
      imageMimeTypes: modelSupportsImage.value
        ? parseMimeTypes(imageMimeTypesText.value).length
          ? parseMimeTypes(imageMimeTypesText.value)
          : [...DEFAULT_IMAGE_MIME_TYPES]
        : [],
      audioMimeTypes: modelSupportsAudio.value
        ? parseMimeTypes(audioMimeTypesText.value).length
          ? parseMimeTypes(audioMimeTypesText.value)
          : [...DEFAULT_AUDIO_MIME_TYPES]
        : [],
    },
  };
  const contextWindow = Number(capabilities.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    selected.contextWindow = Math.trunc(contextWindow);
  } else {
    delete selected.contextWindow;
  }
  const maxOutputTokens = Number(capabilities.maxOutputTokens);
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0)
    selected.maxOutputTokens = Math.trunc(maxOutputTokens);
  else delete selected.maxOutputTokens;
  if (!selected.reasoningEfforts.includes(selected.defaultReasoningEffort!))
    delete selected.defaultReasoningEffort;
  return selected;
}
function parseMimeTypes(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function openProviderForm() {
  editingProviderAccountId.value = '';
  accountName.value = '';
  baseURL.value = '';
  apiKey.value = '';
  showApiKey.value = false;
  providerFormOpen.value = true;
}
function openEditProviderForm(account: { id: string; displayName: string; baseURL: string }) {
  editingProviderAccountId.value = account.id;
  accountName.value = account.displayName;
  baseURL.value = account.baseURL;
  apiKey.value = '';
  showApiKey.value = false;
  providerFormOpen.value = true;
}
function openModelForm(accountId: string) {
  editingModelTargetId.value = '';
  modelAccountId.value = accountId;
  modelName.value = '';
  modelDisplayName.value = '';
  modelProtocol.value = 'chat_completions';
  resetModelModalities(createDefaultModelCapabilities());
}
function openEditModelForm(model: RuntimeModel) {
  if (!model.providerAccountId) return;
  editingModelTargetId.value = model.id;
  modelAccountId.value = model.providerAccountId;
  modelName.value = model.providerModel;
  modelDisplayName.value = model.displayName;
  modelProtocol.value = model.protocol;
  resetModelModalities(model.capabilities);
}
function closeForms() {
  if (saving.value) return;
  providerFormOpen.value = false;
  editingProviderAccountId.value = '';
  modelAccountId.value = '';
  editingModelTargetId.value = '';
}
async function refresh() {
  const result = await loadAgentModels();
  if (result.status === 'error') notify.error(result.message || tr('ui.failedToLoadModelList'));
}
async function submitProvider() {
  if (!canSaveProvider.value) return;
  saving.value = true;
  const result = editingProviderAccountId.value
    ? await updateAgentProvider(editingProviderAccountId.value, {
        displayName: accountName.value.trim(),
        baseURL: baseURL.value.trim(),
        ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
      })
    : await saveAgentProvider({
        displayName: accountName.value.trim(),
        baseURL: baseURL.value.trim(),
        apiKey: apiKey.value.trim(),
      });
  saving.value = false;
  notify.display(result.status, result.message);
  if (result.status === 'success') closeForms();
}
async function submitModel() {
  if (!canSaveModel.value) return;
  saving.value = true;
  const accountId = modelAccountId.value;
  const config: RuntimeModelConfig = {
    providerModel: modelName.value.trim(),
    displayName: modelDisplayName.value.trim() || modelName.value.trim(),
    protocol: modelProtocol.value,
    capabilities: selectedModelCapabilities(),
  };
  const result = editingModelTargetId.value
    ? await updateAgentModel(editingModelTargetId.value, config)
    : await saveAgentModel(accountId, config);
  saving.value = false;
  notify.display(result.status, result.message);
  if (result.status === 'success') {
    expanded.value[accountId] = true;
    closeForms();
  }
}
async function choose(id: string) {
  const result = await selectAgentModel(id);
  if (result.status === 'error') notify.error(result.message || tr('ui.failedToSelectModel'));
}
async function confirmDeleteModel() {
  if (!deleteModelTarget.value) return;
  deleting.value = true;
  const result = await removeAgentModel(deleteModelTarget.value);
  deleting.value = false;
  deleteModelTarget.value = '';
  notify.display(result.status, result.message);
}
async function confirmDeleteAccount() {
  if (!deleteAccountTarget.value) return;
  deleting.value = true;
  const result = await removeAgentProvider(deleteAccountTarget.value);
  deleting.value = false;
  deleteAccountTarget.value = '';
  notify.display(result.status, result.message);
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-white">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl px-6 pb-16 pt-12 sm:px-8 sm:pt-16">
        <h1
          class="text-2xl font-semibold tracking-tight text-gray-900"
          :class="activeSection === 'prompts' ? 'mb-2' : 'mb-10'"
        >
          {{ sectionTitle }}
        </h1>
        <p v-if="activeSection === 'prompts'" class="mb-10 text-xs leading-5 text-gray-500">
          {{ $t('ui.theConversationSystemPromptCombinesThe') }}
        </p>
        <AgentServiceSettings v-if="activeSection === 'agent'" />
        <section v-if="activeSection === 'appearance'">
          <h2 class="text-sm font-medium text-gray-900">
            {{ $t('settings.appearance.colorMode') }}
          </h2>
          <p class="mt-1 text-xs text-gray-500">{{ $t('settings.appearance.colorHelp') }}</p>
          <div
            class="mt-5 grid gap-3 sm:grid-cols-2"
            role="group"
            :aria-label="$t('settings.appearance.colorMode')"
          >
            <button
              type="button"
              class="theme-choice"
              :class="{ 'theme-choice-active': theme === 'light' }"
              :aria-pressed="theme === 'light'"
              @click="setTheme('light')"
            >
              <Sun :size="21" />
              <span>{{ $t('settings.appearance.light') }}</span>
              <Check v-if="theme === 'light'" :size="16" class="ml-auto" />
            </button>
            <button
              type="button"
              class="theme-choice"
              :class="{ 'theme-choice-active': theme === 'dark' }"
              :aria-pressed="theme === 'dark'"
              @click="setTheme('dark')"
            >
              <Moon :size="21" />
              <span>{{ $t('settings.appearance.dark') }}</span>
              <Check v-if="theme === 'dark'" :size="16" class="ml-auto" />
            </button>
          </div>
          <h2 class="mt-10 text-sm font-medium text-gray-900">
            {{ $t('settings.appearance.language') }}
          </h2>
          <p class="mt-1 text-xs text-gray-500">{{ $t('settings.appearance.languageHelp') }}</p>
          <div
            class="mt-5 grid gap-3 sm:grid-cols-3"
            role="group"
            :aria-label="$t('settings.appearance.language')"
          >
            <button
              v-for="option in ['system', 'zh-CN', 'en-US'] as const"
              :key="option"
              type="button"
              class="theme-choice"
              :class="{ 'theme-choice-active': languageMode === option }"
              :aria-pressed="languageMode === option"
              @click="setLanguageMode(option)"
            >
              <span>{{
                $t(
                  `settings.appearance.${option === 'system' ? 'system' : option === 'zh-CN' ? 'chinese' : 'english'}`,
                )
              }}</span>
              <Check v-if="languageMode === option" :size="16" class="ml-auto" />
            </button>
          </div>
        </section>
        <PromptSettings v-if="activeSection === 'prompts'" />
        <WebSearchSettings v-if="activeSection === 'search'" />
        <section v-if="activeSection === 'models'">
          <div
            v-if="configurationLocked"
            class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            {{ $t('ui.modelConfigurationCannotBeChangedWhile') }}
          </div>
          <div
            v-if="store.modelsError"
            class="mb-4 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            <span>{{ store.modelsError }}</span>
            <button class="underline" type="button" @click="refresh">{{ $t('ui.retry') }}</button>
          </div>

          <div class="mb-4 flex items-center justify-between gap-4">
            <div>
              <h2 class="font-semibold text-gray-900">{{ $t('ui.providers') }}</h2>
              <p class="mt-1 text-xs text-gray-500">{{ $t('ui.expandAProviderToManageIts') }}</p>
            </div>
            <button
              class="secondary-button"
              type="button"
              :disabled="configurationLocked"
              @click="openProviderForm"
            >
              <Plus :size="16" />{{ $t('ui.addProvider') }}
            </button>
          </div>

          <div v-if="store.modelsLoading && !store.modelsLoaded" class="space-y-3">
            <div v-for="i in 3" :key="i" class="h-20 animate-pulse rounded-xl border bg-white" />
          </div>
          <div v-else class="space-y-3">
            <p
              v-if="!store.providerAccounts.length"
              class="rounded-xl border border-dashed border-gray-200 px-5 py-8 text-center text-sm text-gray-500"
            >
              {{ $t('ui.thereAreNoProvidersYetAdd') }}
            </p>
            <section
              v-for="account in store.providerAccounts"
              :key="account.id"
              class="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm"
            >
              <div class="provider-header">
                <button
                  class="flex min-w-0 flex-1 items-center gap-3"
                  type="button"
                  @click="toggle(account.id)"
                >
                  <ServerCog :size="20" class="shrink-0 text-gray-500" />
                  <span class="min-w-0 flex-1 text-left">
                    <span class="block truncate font-medium">{{ account.displayName }}</span>
                    <span class="block truncate text-xs text-gray-500">
                      {{ account.baseURL }} · {{ modelsFor(account.id).length }}
                      {{ $t('ui.models') }}
                    </span>
                  </span>
                </button>
                <button
                  class="secondary-button"
                  type="button"
                  :disabled="configurationLocked"
                  @click.stop="openModelForm(account.id)"
                >
                  <Plus :size="14" />{{ $t('ui.addModel') }}
                </button>
                <button
                  class="icon-button"
                  type="button"
                  :title="$t('ui.editProvider')"
                  :disabled="configurationLocked"
                  @click.stop="openEditProviderForm(account)"
                >
                  <Pencil :size="15" />
                </button>
                <button
                  class="icon-button hover:text-red-600"
                  type="button"
                  :title="$t('ui.deleteProvider')"
                  :disabled="configurationLocked"
                  @click.stop="deleteAccountTarget = account.id"
                >
                  <Trash2 :size="15" />
                </button>
                <button
                  class="icon-button"
                  type="button"
                  :title="$t('ui.expandModels')"
                  @click="toggle(account.id)"
                >
                  <ChevronDown
                    :size="18"
                    class="transition-transform"
                    :class="expanded[account.id] ? 'rotate-180' : ''"
                  />
                </button>
              </div>
              <div v-if="expanded[account.id]" class="model-list">
                <div
                  v-for="item in modelsFor(account.id)"
                  :key="item.id"
                  class="model-row"
                  :class="item.id === store.selectedModel ? 'selected-model' : ''"
                >
                  <button
                    class="flex min-w-0 flex-1 items-center gap-3 text-left"
                    type="button"
                    :disabled="!item.enabled || item.compatible === false"
                    @click="choose(item.id)"
                  >
                    <span class="model-check">
                      <Check v-if="item.id === store.selectedModel" :size="15" />
                    </span>
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium">{{ item.displayName }}</span>
                      <span class="block text-xs text-gray-500">
                        {{ item.providerModel }} ·
                        {{ item.protocol === 'responses' ? 'Responses' : 'Chat Completions' }}
                      </span>
                      <span v-if="item.compatible === false" class="block text-xs text-amber-700">
                        {{ item.incompatibilityReasons?.join('；') }}
                      </span>
                    </span>
                  </button>
                  <button
                    class="icon-button"
                    type="button"
                    :title="$t('ui.editModel')"
                    :disabled="configurationLocked"
                    @click="openEditModelForm(item)"
                  >
                    <Pencil :size="15" />
                  </button>
                  <button
                    class="icon-button hover:text-red-600"
                    type="button"
                    :title="$t('ui.deleteModel')"
                    :disabled="configurationLocked"
                    @click="deleteModelTarget = item.id"
                  >
                    <Trash2 :size="15" />
                  </button>
                </div>
                <button
                  v-if="!modelsFor(account.id).length"
                  class="w-full py-5 text-center text-sm text-gray-500 hover:bg-gray-50"
                  type="button"
                  @click="openModelForm(account.id)"
                >
                  {{ $t('ui.noModelsYetClickToAdd') }}
                </button>
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="providerFormOpen" class="modal-backdrop" @mousedown.self="closeForms">
        <section class="modal-card">
          <header class="modal-header">
            <h2 class="font-semibold">
              {{ editingProviderAccountId ? $t('ui.editProvider') : $t('ui.addProvider') }}
            </h2>
            <button class="icon-button" @click="closeForms"><X :size="18" /></button>
          </header>
          <form class="mt-5 space-y-4" @submit.prevent="submitProvider">
            <label class="block">
              <span class="field-label">{{ $t('ui.providerName') }}</span>
              <input
                v-model="accountName"
                class="field-input"
                :placeholder="$t('ui.forExampleSelfHostedModelService')"
              />
            </label>
            <label class="block">
              <span class="field-label">{{ $t('ui.endpointUrl') }}</span>
              <input
                v-model="baseURL"
                class="field-input"
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label class="block">
              <span class="field-label">
                API Key{{ editingProviderAccountId ? $t('ui.leaveBlankToKeepItUnchanged') : '' }}
              </span>
              <span class="relative block">
                <input
                  v-model="apiKey"
                  class="secret-input field-input pr-11"
                  :type="showApiKey ? 'text' : 'password'"
                  autocomplete="new-password"
                />
                <button
                  class="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-400"
                  type="button"
                  @click="showApiKey = !showApiKey"
                >
                  <EyeOff v-if="showApiKey" :size="16" />
                  <Eye v-else :size="16" />
                </button>
              </span>
            </label>
          </form>
          <footer class="modal-footer">
            <button class="secondary-button" @click="closeForms">{{ $t('ui.cancel') }}</button>
            <button class="primary-button" :disabled="!canSaveProvider" @click="submitProvider">
              {{ saving ? $t('ui.saving') : $t('ui.saveProvider') }}
            </button>
          </footer>
        </section>
      </div>

      <div v-if="modelAccountId" class="modal-backdrop" @mousedown.self="closeForms">
        <section class="model-modal-card">
          <header class="modal-header">
            <h2 class="font-semibold">
              {{ editingModelTargetId ? $t('ui.editModel') : $t('ui.addModel') }}
            </h2>
            <button class="icon-button" @click="closeForms"><X :size="18" /></button>
          </header>
          <p class="mt-2 text-xs text-gray-500">
            {{
              $t('dynamic.providerUsesCredentials', {
                name:
                  store.providerAccounts.find((item) => item.id === modelAccountId)?.displayName ||
                  '',
              })
            }}
          </p>
          <form class="model-form" @submit.prevent="submitModel">
            <label class="block">
              <span class="field-label">{{ $t('ui.modelId') }}</span>
              <input
                v-model="modelName"
                class="field-input"
                :placeholder="$t('ui.forExampleDeepseekChat')"
              />
            </label>
            <label class="block">
              <span class="field-label">{{ $t('ui.displayNameOptional') }}</span>
              <input
                v-model="modelDisplayName"
                class="field-input"
                :placeholder="$t('ui.usesTheModelIdByDefault')"
              />
            </label>
            <label class="block">
              <span class="field-label">{{ $t('ui.apiProtocol') }}</span>
              <select v-model="modelProtocol" class="field-input bg-white">
                <option value="responses">Responses API</option>
                <option value="chat_completions">Chat Completions API</option>
                <option value="anthropic_messages">Anthropic Messages API</option>
              </select>
            </label>
            <label class="block">
              <span class="field-label">{{ $t('ui.contextWindow') }}</span>
              <input
                v-model.number="modelCapabilities.contextWindow"
                class="field-input"
                type="number"
                min="1"
                step="1"
                :placeholder="$t('ui.forExample128000')"
              />
              <span class="mt-1 block text-xs text-gray-500">
                {{ $t('ui.maximumContextTokensSupportedByThe') }}
              </span>
            </label>
            <fieldset class="md:col-span-2">
              <legend class="field-label">{{ $t('ui.inputModalities') }}</legend>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <label class="modality-option opacity-70">
                  <input type="checkbox" checked disabled />
                  <span
                    ><strong>{{ $t('ui.text') }}</strong></span
                  >
                </label>
                <label class="modality-option">
                  <input v-model="modelSupportsImage" type="checkbox" />
                  <span
                    ><strong>{{ $t('ui.images') }}</strong></span
                  >
                </label>
                <label class="modality-option">
                  <input v-model="modelSupportsAudio" type="checkbox" />
                  <span
                    ><strong>{{ $t('ui.audio') }}</strong></span
                  >
                </label>
              </div>
              <p class="mt-2 text-xs text-gray-500">
                {{ $t('ui.selectTheModelSActualCapabilities') }}
              </p>
              <label v-if="modelSupportsImage" class="mt-3 block">
                <span class="field-label">{{ $t('ui.imageMimeTypes') }}</span>
                <input
                  v-model="imageMimeTypesText"
                  class="field-input"
                  placeholder="image/jpeg, image/png"
                />
              </label>
              <label v-if="modelSupportsAudio" class="mt-3 block">
                <span class="field-label">{{ $t('ui.audioMimeTypes') }}</span>
                <input
                  v-model="audioMimeTypesText"
                  class="field-input"
                  placeholder="audio/wav, audio/mpeg"
                />
              </label>
            </fieldset>
            <fieldset class="md:col-span-2">
              <legend class="field-label">{{ $t('ui.toolCalling') }}</legend>
              <div class="grid gap-2 sm:grid-cols-2">
                <label class="modality-option">
                  <input v-model="modelCapabilities.toolCalling" type="checkbox" />
                  <span
                    ><strong>{{ $t('ui.supportsToolCalling') }}</strong></span
                  >
                </label>
                <label
                  class="modality-option"
                  :class="!modelCapabilities.toolCalling ? 'cursor-not-allowed opacity-60' : ''"
                >
                  <input
                    v-model="modelCapabilities.parallelToolCalls"
                    type="checkbox"
                    :disabled="!modelCapabilities.toolCalling"
                  />
                  <span
                    ><strong>{{ $t('ui.supportsParallelToolCalls') }}</strong></span
                  >
                </label>
              </div>
            </fieldset>
            <fieldset class="md:col-span-2">
              <legend class="field-label">{{ $t('ui.providerNativeTools') }}</legend>
              <label
                class="modality-option native-web-search-option"
                :class="modelProtocol !== 'responses' ? 'cursor-not-allowed opacity-60' : ''"
              >
                <input
                  v-model="modelCapabilities.nativeWebSearch"
                  type="checkbox"
                  :disabled="modelProtocol !== 'responses'"
                />
                <span>
                  <strong>{{ $t('ui.nativeWebSearch') }}</strong>
                  <small>{{ $t('ui.sendWebSearchToTheResponses') }}</small>
                </span>
              </label>
            </fieldset>
            <fieldset class="md:col-span-2">
              <legend class="field-label">{{ $t('ui.reasoningEffort') }}</legend>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <label v-for="effort in REASONING_EFFORTS" :key="effort" class="modality-option">
                  <input
                    v-model="modelCapabilities.reasoningEfforts"
                    :value="effort"
                    type="checkbox"
                  />
                  <span>
                    <strong>{{ effort }}</strong>
                  </span>
                </label>
              </div>
              <label class="mt-3 block">
                <span class="field-label">{{ $t('ui.defaultReasoningEffort') }}</span>
                <select
                  v-model="modelCapabilities.defaultReasoningEffort"
                  class="field-input bg-white"
                >
                  <option :value="undefined">{{ $t('ui.notSet') }}</option>
                  <option
                    v-for="effort in modelCapabilities.reasoningEfforts"
                    :key="effort"
                    :value="effort"
                  >
                    {{ effort }}
                  </option>
                </select>
              </label>
            </fieldset>
            <label class="block">
              <span class="field-label">{{ $t('ui.maximumOutputTokens') }}</span>
              <input
                v-model.number="modelCapabilities.maxOutputTokens"
                class="field-input"
                type="number"
                min="1"
                step="1"
                :placeholder="$t('ui.forExample16384')"
              />
            </label>
          </form>
          <footer class="modal-footer">
            <button class="secondary-button" @click="closeForms">{{ $t('ui.cancel') }}</button>
            <button class="primary-button" :disabled="!canSaveModel" @click="submitModel">
              {{
                saving
                  ? $t('ui.saving')
                  : editingModelTargetId
                    ? $t('ui.saveChanges')
                    : $t('ui.addModelAction')
              }}
            </button>
          </footer>
        </section>
      </div>

      <div v-if="deleteModelTarget || deleteAccountTarget" class="modal-backdrop">
        <section class="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl">
          <h2 class="font-semibold">{{ $t('ui.confirmDeletion') }}</h2>
          <p class="mt-3 text-sm text-gray-600">
            {{
              deleteAccountTarget
                ? $t('ui.theProviderSModelsAndSaved')
                : $t('ui.thisModelWillNoLongerBe')
            }}
          </p>
          <div class="modal-footer">
            <button
              class="secondary-button"
              @click="
                deleteModelTarget = '';
                deleteAccountTarget = '';
              "
            >
              {{ $t('ui.cancel') }}
            </button>
            <button
              class="rounded-lg bg-red-600 px-3 py-2 text-sm text-white"
              :disabled="deleting"
              @click="deleteModelTarget ? confirmDeleteModel() : confirmDeleteAccount()"
            >
              {{ $t('ui.confirmDeletion') }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@reference "tailwindcss";
.theme-choice {
  @apply flex h-20 items-center gap-3 rounded-xl border border-gray-200 bg-white px-5 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400;
}
.theme-choice-active {
  @apply border-gray-500 bg-gray-50 text-gray-900 ring-1 ring-gray-300;
}
.theme-choice:focus-visible {
  @apply outline-2 outline-offset-2 outline-gray-500;
}
.icon-button {
  @apply inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-40;
}
.secondary-button {
  @apply inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40;
}
.primary-button {
  @apply inline-flex h-9 items-center justify-center rounded-lg bg-gray-900 px-4 text-sm font-medium text-white disabled:opacity-40;
}
.provider-header {
  @apply flex w-full items-center gap-3 px-4 py-4;
}
.model-list {
  @apply border-t border-gray-100 bg-gray-50/60 px-3 py-2;
}
.model-row {
  @apply flex w-full items-center gap-3 rounded-lg px-3 py-2.5 mt-1.5 text-gray-700 disabled:opacity-50;
}
.selected-model {
  @apply bg-white text-gray-950 ring-1 ring-gray-300;
}
.model-check {
  @apply flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gray-100;
}
.selected-model .model-check {
  @apply bg-gray-900 text-white;
}
.modality-option {
  @apply flex cursor-pointer items-start gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 transition hover:border-gray-300;
}
.modality-option input {
  @apply mt-0.5 h-4 w-4 shrink-0 accent-gray-900;
}
.modality-option span {
  @apply min-w-0;
}
.modality-option strong {
  @apply block font-medium;
}
.modality-option small {
  @apply block truncate text-xs text-gray-500;
}
.native-web-search-option span {
  @apply flex flex-wrap items-baseline gap-x-2;
}
.native-web-search-option strong,
.native-web-search-option small {
  @apply inline;
}
.modal-backdrop {
  @apply fixed inset-0 z-60 flex items-center justify-center bg-black/25 p-4;
}
.modal-card {
  @apply w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl;
}
.model-modal-card {
  @apply max-h-[calc(100vh-2rem)] w-full max-w-5xl overflow-y-auto rounded-xl border bg-white p-5 shadow-2xl;
}
.model-form {
  @apply mt-5 grid gap-4 md:grid-cols-2;
}
.modal-header {
  @apply flex items-center justify-between;
}
.modal-footer {
  @apply mt-6 flex justify-end gap-2;
}
.field-label {
  @apply mb-1.5 block text-sm font-medium text-gray-700;
}
.field-input {
  @apply h-10 w-full rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-100 disabled:bg-gray-100 disabled:text-gray-500;
}
.secret-input::-ms-reveal,
.secret-input::-ms-clear {
  display: none;
}
</style>
