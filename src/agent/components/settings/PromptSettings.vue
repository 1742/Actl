<script setup lang="ts">
import { tr } from '../../../i18n';
import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, Save, Trash2 } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import { useNotifyStore } from '../../../composables/notify';
import { getAgentRuntimeClient } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimePromptBlock } from '../../types';

const store = useAgentStore();
const notify = useNotifyStore();
const blocks = ref<RuntimePromptBlock[]>([]);
const revision = ref(0);
const savedBlocks = ref('[]');
const loading = ref(true);
const saving = ref(false);
const expandedBlocks = ref<Record<string, boolean>>({});
const locked = computed(() => store.hasActiveResponse || loading.value || saving.value);
const changed = computed(() => JSON.stringify(blocks.value) !== savedBlocks.value);
const canSave = computed(
  () =>
    !locked.value &&
    changed.value &&
    blocks.value.every((block) => block.title.trim() && block.text.length <= 30_000),
);

function client() {
  return getAgentRuntimeClient(store.runtimeKind);
}

async function load() {
  loading.value = true;
  try {
    const settings = await client().getPromptSettings();
    revision.value = settings.revision;
    blocks.value = settings.blocks;
    savedBlocks.value = JSON.stringify(settings.blocks);
    expandedBlocks.value = {};
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToLoadPromptConfiguration'));
  } finally {
    loading.value = false;
  }
}

function addBlock() {
  if (locked.value || blocks.value.length >= 40) return;
  const id = `custom:${crypto.randomUUID()}`;
  blocks.value.push({ id, title: tr('ui.newPromptBlock'), text: '', enabled: true });
  expandedBlocks.value[id] = true;
}

function removeBlock(id: string) {
  if (locked.value) return;
  blocks.value = blocks.value.filter((block) => block.id !== id);
  delete expandedBlocks.value[id];
}

function toggleBlock(id: string) {
  expandedBlocks.value[id] = !expandedBlocks.value[id];
}

function moveBlock(from: number, to: number) {
  if (
    locked.value ||
    from < 0 ||
    to < 0 ||
    from >= blocks.value.length ||
    to >= blocks.value.length ||
    from === to
  )
    return;
  const [block] = blocks.value.splice(from, 1);
  if (block) blocks.value.splice(to, 0, block);
}

function moveBy(id: string, offset: number) {
  const index = blocks.value.findIndex((block) => block.id === id);
  moveBlock(index, index + offset);
}

async function restoreDefaults() {
  if (locked.value) return;
  try {
    const defaults = await client().getDefaultPromptSettings();
    blocks.value = defaults.blocks.map((block) => ({ ...block }));
    expandedBlocks.value = Object.fromEntries(defaults.blocks.map((block) => [block.id, true]));
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToLoadDefaultPrompts'));
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const settings = await client().savePromptSettings({
      revision: revision.value,
      blocks: blocks.value,
    });
    revision.value = settings.revision;
    blocks.value = settings.blocks;
    savedBlocks.value = JSON.stringify(settings.blocks);
    notify.success(tr('ui.promptsSaved'));
  } catch (error) {
    notify.error(error instanceof Error ? error.message : tr('ui.failedToSavePrompts'));
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="mb-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-gray-900">{{ $t('ui.userPrompts') }}</h2>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            class="secondary-button"
            :title="$t('ui.replaceAllUserBlocksWithThe')"
            :disabled="locked"
            @click="restoreDefaults"
          >
            <RotateCcw :size="15" />{{ $t('ui.restoreDefaults') }}
          </button>
          <button
            type="button"
            class="secondary-button"
            :disabled="locked || blocks.length >= 40"
            @click="addBlock"
          >
            <Plus :size="15" />{{ $t('ui.addBlock') }}
          </button>
          <button type="button" class="secondary-button" :disabled="!canSave" @click="save">
            <Save :size="15" />{{ saving ? $t('ui.saving') : $t('ui.savePrompts') }}
          </button>
        </div>
      </div>
    </div>

    <p
      v-if="store.hasActiveResponse"
      class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      {{ $t('ui.promptsCannotBeChangedWhileA') }}
    </p>

    <p v-if="loading" class="text-sm text-gray-500">{{ $t('ui.loadingPrompts') }}</p>
    <div v-else class="space-y-3">
      <p
        v-if="blocks.length === 0"
        class="rounded-2xl border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500"
      >
        {{ $t('ui.thereAreNoUserPromptBlocks') }}
      </p>
      <section
        v-for="(block, index) in blocks"
        :key="block.id"
        class="rounded-2xl border border-gray-200 bg-white px-4 py-3"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            class="rounded p-1 text-gray-500 hover:bg-gray-100"
            :aria-expanded="Boolean(expandedBlocks[block.id])"
            :aria-label="`${expandedBlocks[block.id] ? $t('ui.collapseBlock') : $t('ui.expand')}${block.title}`"
            @click="toggleBlock(block.id)"
          >
            <ChevronDown
              :size="17"
              class="transition-transform"
              :class="expandedBlocks[block.id] ? '' : '-rotate-90'"
            />
          </button>
          <input
            v-model="block.title"
            class="min-w-32 flex-1 rounded border border-transparent px-1 py-1 text-sm font-medium text-gray-900 hover:border-gray-200 focus:border-gray-300 focus:outline-none"
            :disabled="locked"
            maxlength="80"
            :aria-label="$t('ui.promptBlockName')"
          />
          <span class="shrink-0 text-xs text-gray-400"
            >{{ block.text.length }} {{ $t('ui.characters') }}</span
          >
          <label class="flex shrink-0 items-center gap-1 text-xs text-gray-600">
            <input v-model="block.enabled" type="checkbox" :disabled="locked" />{{
              $t('ui.enable')
            }}
          </label>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
              :title="$t('ui.moveUp')"
              :disabled="locked || index === 0"
              @click="moveBy(block.id, -1)"
            >
              <ArrowUp :size="17" />
            </button>
            <button
              type="button"
              class="rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-40"
              :title="$t('ui.moveDown')"
              :disabled="locked || index === blocks.length - 1"
              @click="moveBy(block.id, 1)"
            >
              <ArrowDown :size="17" />
            </button>
            <button
              type="button"
              class="rounded p-1 text-red-500 hover:bg-red-50 disabled:opacity-40"
              :title="$t('ui.deleteBlock')"
              :disabled="locked"
              @click="removeBlock(block.id)"
            >
              <Trash2 :size="15" />
            </button>
          </div>
        </div>
        <textarea
          v-if="expandedBlocks[block.id]"
          v-model="block.text"
          class="mt-3 min-h-40 w-full resize-y rounded-lg border border-gray-200 p-3 font-mono text-xs leading-5 text-gray-800 focus:border-gray-400 focus:outline-none"
          :class="block.text.length > 1000 ? 'min-h-72' : ''"
          :disabled="locked"
          maxlength="30000"
          :placeholder="$t('ui.enterTextToAddToThe')"
          :aria-label="$t('dynamic.promptsBody', { title: block.title })"
        />
      </section>
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";
.secondary-button {
  @apply inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40;
}
</style>
