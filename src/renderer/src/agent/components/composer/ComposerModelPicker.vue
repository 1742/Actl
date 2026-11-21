<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Check, ChevronLeft, ChevronRight, RotateCcw } from '@lucide/vue';
import type { ReasoningEffort } from '../../../../../shared/agent/models';
import FloatingMenu from '../../../components/FloatingMenu.vue';

export interface ComposerModelOption {
  label: string;
  value: string;
}

export interface ComposerReasoningOption {
  label: string;
  value: ReasoningEffort;
  description?: string;
}

const props = defineProps<{
  model: string;
  models: ComposerModelOption[];
  reasoningEffort?: ReasoningEffort | undefined;
  reasoningOptions: ComposerReasoningOption[];
  defaultReasoningEffort?: ReasoningEffort | undefined;
  disabled?: boolean;
  saving?: boolean;
}>();

const emit = defineEmits<{
  'update:model': [value: string];
  'update:reasoningEffort': [value: ReasoningEffort];
}>();

const menu = ref<{ close: () => void }>();
const trigger = ref<HTMLButtonElement>();
const modelList = ref<HTMLElement>();
const slider = ref<HTMLInputElement>();
const modelsTab = ref<HTMLButtonElement>();
const pane = ref<'reasoning' | 'models'>('models');
const open = ref(false);
const preview = ref<number>();

const hasReasoning = computed(() => props.reasoningOptions.length > 0);
const showingReasoning = computed(() => hasReasoning.value && pane.value === 'reasoning');
const modelLabel = computed(() => props.models.find(({ value }) => value === props.model)?.label ?? props.model);
const defaultOption = computed(() => props.reasoningOptions.find(({ value }) => value === props.defaultReasoningEffort) ?? props.reasoningOptions[0]);
const selectedIndex = computed(() => props.reasoningOptions.findIndex(({ value }) => value === (props.reasoningEffort ?? defaultOption.value?.value)));
const selectedEffort = computed(() => props.reasoningOptions[selectedIndex.value]);
const sliderIndex = computed(() => preview.value ?? Math.max(0, selectedIndex.value));
const visibleEffort = computed(() => props.reasoningOptions[sliderIndex.value]);
const lastIndex = computed(() => props.reasoningOptions.length - 1);
const atMaximum = computed(() => lastIndex.value > 0 && sliderIndex.value === lastIndex.value);
const trackStyle = computed(() => ({ '--effort-fraction': lastIndex.value > 0 ? sliderIndex.value / lastIndex.value : 0 }));

const sparkStyles = [
  { start: 3, end: 34, count: 8 },
  { start: 34, end: 68, count: 8 },
  { start: 68, end: 89, count: 3 },
].flatMap(({ start, end, count }) => Array.from({ length: count }, (_, index) => {
  const direction = Math.random() < 0.5 ? -1 : 1;
  const size = `${1 + Math.random() * 0.6}px`;
  return {
    left: `${start + (index + Math.random()) * (end - start) / count}%`,
    top: `${30 + Math.random() * 36}%`,
    width: size,
    height: size,
    '--drift-x': `${direction * (2 + Math.random() * 3)}px`,
    '--drift-y': `${2 + Math.random() * 3}px`,
    animationDuration: `${2.4 + Math.random() * 2}s`,
    animationDelay: `${-Math.random() * 5}s`,
  };
}));

async function showPane(value: 'reasoning' | 'models') {
  pane.value = value;
  preview.value = undefined;
  await nextTick();
  requestAnimationFrame(() => {
    if (!open.value || pane.value !== value) return;
    if (showingReasoning.value) {
      (slider.value?.disabled === false ? slider.value : modelsTab.value)?.focus();
    } else {
      const selected = modelList.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      (selected ?? modelList.value?.querySelector('button'))?.focus();
    }
  });
}

function handleOpen(value: boolean) {
  open.value = value;
  if (value) void showPane(hasReasoning.value ? 'reasoning' : 'models');
  else preview.value = undefined;
}

function closeMenu() {
  menu.value?.close();
  trigger.value?.focus();
}

function chooseModel(value: string) {
  if (props.saving) return;
  if (value !== props.model) emit('update:model', value);
  closeMenu();
}

function updatePreview(event: Event) {
  preview.value = (event.currentTarget as HTMLInputElement).valueAsNumber;
}

function commitEffort(event: Event) {
  const option = props.reasoningOptions[(event.currentTarget as HTMLInputElement).valueAsNumber];
  preview.value = undefined;
  if (!props.saving && option && option.value !== selectedEffort.value?.value) emit('update:reasoningEffort', option.value);
}

function resetEffort() {
  if (!props.saving && defaultOption.value) emit('update:reasoningEffort', defaultOption.value.value);
}
</script>

<template>
  <FloatingMenu ref="menu" placement="top-end" trigger-class="min-w-0 max-w-full"
    :close-on-menu-click="false" @update:open="handleOpen">
    <template #trigger>
      <button ref="trigger" type="button"
        class="flex h-7 min-w-0 max-w-full items-center rounded-full px-4 text-sm text-gray-500 hover:bg-gray-100 aria-expanded:bg-gray-100 disabled:opacity-60"
        :disabled="disabled" :aria-expanded="open" aria-haspopup="dialog"
        :aria-label="hasReasoning ? $t('ui.chooseAModelAndReasoningEffort') : $t('ui.chooseModel')"
        :title="[modelLabel, selectedEffort?.label].filter(Boolean).join(' · ')"
        @keydown.esc.stop.prevent="closeMenu">
        <span v-if="open && hasReasoning" class="truncate">{{ $t('ui.chooseReasoningEffort') }}</span>
        <template v-else>
          <span class="truncate text-gray-900">{{ modelLabel || $t('ui.chooseModel') }}</span>
          <span v-if="selectedEffort" class="ml-1 shrink-0 text-gray-400">{{ selectedEffort.label }}</span>
        </template>
      </button>
    </template>

    <template #menu>
      <section class="w-61.5 max-w-[calc(100vw-1.5rem)] text-sm" role="dialog"
        :aria-label="hasReasoning ? $t('ui.chooseAModelAndReasoningEffort') : $t('ui.chooseModel')"
        @keydown.esc.stop.prevent="closeMenu">
        <div v-if="showingReasoning" class="px-2 pt-1 pb-2">
          <div class="grid grid-cols-[20px_minmax(0,1fr)_20px] items-center text-gray-500">
            <button ref="modelsTab" type="button"
              class="col-start-2 flex min-w-28 max-w-full flex-col items-center justify-self-center rounded-md px-3 py-1 hover:bg-gray-100 focus-visible:bg-gray-100"
              :title="visibleEffort?.description" :aria-label="[$t('ui.chooseModel'), modelLabel, visibleEffort?.label].filter(Boolean).join(' · ')"
              @click="showPane('models')">
              <span class="max-w-full truncate text-md leading-5 font-medium" :class="atMaximum ? 'text-violet-500' : 'text-blue-600'">{{ visibleEffort?.label }}</span>
              <span class="flex max-w-full items-center text-[13px] leading-5 text-gray-500">
                <span class="truncate">{{ modelLabel }}</span>
                <ChevronRight :size="12" class="shrink-0" aria-hidden="true" />
              </span>
            </button>
            <button type="button" class="grid size-6 place-items-center justify-self-end self-start rounded-full hover:bg-gray-100 disabled:opacity-50"
              :title="$t('ui.resetReasoningEffort')" :aria-label="$t('ui.resetReasoningEffort')"
              :disabled="saving || !defaultOption || defaultOption.value === selectedEffort?.value" @click="resetEffort">
              <RotateCcw :size="14" aria-hidden="true" />
            </button>
          </div>
          <div v-if="lastIndex > 0" class="effort-track" :class="{ filled: sliderIndex > 0, maximum: atMaximum }" :style="trackStyle">
            <div v-if="atMaximum" class="effort-sparks" aria-hidden="true">
              <i v-for="(style, index) in sparkStyles" :key="index" :style="style" />
            </div>
            <div v-else class="effort-scale" aria-hidden="true">
              <i v-for="option in reasoningOptions" :key="option.value" />
            </div>
            <input ref="slider" class="effort-slider" type="range" min="0" :max="lastIndex" step="1"
              :value="sliderIndex" :disabled="saving" :aria-label="$t('ui.reasoningEffort')"
              :aria-valuetext="visibleEffort?.label" @input="updatePreview" @change="commitEffort" />
          </div>
        </div>
        <div v-else>
          <div class="relative flex h-8 items-center justify-center text-sm font-medium text-gray-600">
            <button v-if="hasReasoning" type="button" class="absolute left-1 grid size-6 place-items-center rounded-full hover:bg-gray-100"
              :aria-label="$t('ui.chooseReasoningEffort')" @click="showPane('reasoning')">
              <ChevronLeft :size="15" aria-hidden="true" />
            </button>
            {{ $t('ui.chooseModel') }}
          </div>
          <div ref="modelList" class="max-h-[min(20rem,55vh)] overflow-y-auto p-1" :aria-label="$t('ui.chooseModel')" role="group">
          <button v-for="option in models" :key="option.value" type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-gray-800 hover:bg-gray-50 aria-pressed:bg-gray-100 disabled:opacity-60"
            :aria-pressed="option.value === model" :disabled="saving" @click="chooseModel(option.value)">
            <span class="min-w-0 flex-1 truncate" :title="option.label">{{ option.label }}</span>
            <Check v-if="option.value === model" :size="15" class="shrink-0" aria-hidden="true" />
          </button>
          </div>
        </div>
      </section>
    </template>
  </FloatingMenu>
</template>

<style scoped>
@reference "tailwindcss";

.effort-track {
  position: relative;
  height: 24px;
  margin-top: 10px;
  border-radius: 999px;
  background: var(--color-neutral-200);
}

.effort-track.filled::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: calc(13px + (100% - 26px) * var(--effort-fraction));
  border-radius: inherit;
  background: var(--color-blue-500);
}

.effort-scale {
  position: absolute;
  inset: 0 11px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.effort-track.maximum::before {
  width: 100%;
  background: linear-gradient(105deg, #204bdc, #6861fa 30%, #ac76ff 55%, #9557fb 75%, #7867ff);
}

.effort-sparks {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
}

.effort-sparks i {
  position: absolute;
  border-radius: 50%;
  background: white;
  box-shadow: 0 0 1px rgb(255 255 255 / 60%);
  animation: spark-float ease-in-out infinite;
}

@keyframes spark-float {
  0%, 100% { transform: translate(0, 0); opacity: .5; }
  32% { transform: translate(var(--drift-x), calc(-1 * var(--drift-y))); opacity: .9; }
  70% { transform: translate(calc(-0.7 * var(--drift-x)), var(--drift-y)); opacity: .65; }
}

@media (prefers-reduced-motion: reduce) {
  .effort-sparks i { animation-play-state: paused; }
}

.effort-scale i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgb(0 0 0 / 22%);
}

.effort-slider {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  appearance: none;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
}

.effort-slider:focus-visible {
  outline: 2px solid var(--color-blue-400);
  outline-offset: 3px;
}

.effort-slider::-webkit-slider-thumb {
  appearance: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 5%), 0 1px 3px rgb(0 0 0 / 12%);
}
</style>
