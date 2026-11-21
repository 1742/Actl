<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUp, Square } from '@lucide/vue';
import type { ReasoningEffort } from '../../../../../shared/agent/models';
import ComposerModelPicker, { type ComposerModelOption, type ComposerReasoningOption } from './ComposerModelPicker.vue';

export interface AgentMessageInputProps {
  modelValue?: string;
  model: string;
  modelOptions?: ComposerModelOption[];
  reasoningEffort?: ReasoningEffort | undefined;
  reasoningOptions?: ComposerReasoningOption[];
  defaultReasoningEffort?: ReasoningEffort | undefined;
  modelPreferenceSaving?: boolean;
  showReasoningControl?: boolean;
  placeholder?: string;
  loading?: boolean;
  stopDisabled?: boolean;
  disabled?: boolean;
  canSubmit?: boolean;
  hideComposer?: boolean;
  variant?: 'light' | 'dark';
  containerClass?: string;
  shellClass?: string;
  layoutKey?: string | number;
}

const props = withDefaults(defineProps<AgentMessageInputProps>(), {
  modelValue: '',
  modelOptions: () => [],
  reasoningEffort: undefined,
  reasoningOptions: () => [],
  modelPreferenceSaving: false,
  showReasoningControl: false,
  placeholder: tr('ui.typeAMessage'),
  loading: false,
  stopDisabled: false,
  disabled: false,
  canSubmit: undefined,
  hideComposer: false,
  variant: 'light',
  containerClass: '',
  shellClass: '',
  layoutKey: 0,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:model': [value: string];
  'update:reasoningEffort': [value: ReasoningEffort];
  submit: [value: string];
  stop: [];
  heightChange: [height: number];
  keydown: [event: KeyboardEvent];
}>();

const containerRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const MIN_TEXTAREA_HEIGHT = 48;
const MAX_TEXTAREA_HEIGHT = 180;
let heightFrame = 0;
let lastTextareaHeight = 0;
let lastContainerHeight = 0;
let containerResizeObserver: ResizeObserver | undefined;

const isDark = computed(() => props.variant === 'dark');
const trimmedText = computed(() => props.modelValue.trim());
const canSend = computed(() => {
  if (props.disabled || props.loading) return false;
  if (props.canSubmit !== undefined) return props.canSubmit;
  return Boolean(trimmedText.value);
});

const outerClasses = computed(() => [
  'flex w-full flex-col',
  props.containerClass,
  isDark.value ? 'bg-[#151515]' : 'bg-white',
]);

const shellClasses = computed(() => [
  'flex w-full flex-col border',
  props.shellClass,
  isDark.value ? 'border-gray-700 bg-[#151515]' : 'border-gray-200 bg-white',
]);

const textareaClasses = computed(() => [
  'max-h-45 min-h-12 w-full resize-none bg-transparent px-1 py-2 text-[15px] leading-relaxed outline-none',
  isDark.value
    ? 'text-gray-200 placeholder:text-gray-500'
    : 'text-gray-800 placeholder:text-gray-400',
]);

const sendButtonClasses = computed(() => [
  'send-button flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60',
  props.loading
    ? 'send-button-active text-primary-fg active:scale-95'
    : canSend.value
      ? 'send-button-active text-primary-fg active:scale-95'
      : 'cursor-not-allowed bg-gray-100 text-gray-400',
]);

const measureInputHeight = () => {
  heightFrame = 0;
  const textarea = textareaRef.value;

  if (textarea) {
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const nextTextareaHeight = Math.min(
      Math.max(scrollHeight, MIN_TEXTAREA_HEIGHT),
      MAX_TEXTAREA_HEIGHT,
    );

    textarea.style.height = `${nextTextareaHeight}px`;
    textarea.style.overflowY = scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
    lastTextareaHeight = nextTextareaHeight;
  }

  const nextContainerHeight = containerRef.value?.offsetHeight || 120;
  if (nextContainerHeight !== lastContainerHeight || lastTextareaHeight) {
    lastContainerHeight = nextContainerHeight;
    emit('heightChange', nextContainerHeight);
  }
};

const scheduleInputHeight = async () => {
  await nextTick();
  if (heightFrame) cancelAnimationFrame(heightFrame);
  heightFrame = requestAnimationFrame(measureInputHeight);
};

const updateText = (event: Event) => {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value);
};

const submit = () => {
  if (!canSend.value) return;
  emit('submit', trimmedText.value);
};

const handleAction = () => {
  if (props.loading) {
    emit('stop');
    return;
  }
  submit();
};

const onKeyDown = (event: KeyboardEvent) => {
  emit('keydown', event);
  if (event.defaultPrevented) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
};

watch(
  () => props.modelValue,
  () => scheduleInputHeight(),
  { flush: 'post' },
);
watch(
  () => props.layoutKey,
  () => scheduleInputHeight(),
  { flush: 'post' },
);
onMounted(() => {
  scheduleInputHeight();
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    containerResizeObserver = new ResizeObserver(() => scheduleInputHeight());
    containerResizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  if (heightFrame) cancelAnimationFrame(heightFrame);
  containerResizeObserver?.disconnect();
});
</script>

<template>
  <div ref="containerRef" :class="outerClasses">
    <div :class="shellClasses">
      <slot name="attachments" />

      <div v-if="!hideComposer" class="flex min-h-0 flex-col px-4 pb-3 pt-3">
        <slot name="editor" :disabled="disabled" :placeholder="placeholder">
          <textarea
            ref="textareaRef"
            :value="modelValue"
            :placeholder="placeholder"
            :disabled="disabled"
            rows="1"
            :class="textareaClasses"
            @input="updateText"
            @keydown="onKeyDown"
          ></textarea>
        </slot>

        <div class="flex min-h-10 min-w-0 shrink-0 items-center gap-2">
          <div class="mr-auto flex shrink-0 items-center gap-1">
            <slot name="left-tools" />
          </div>

          <div v-if="modelOptions.length" class="min-w-0 max-w-52">
            <ComposerModelPicker
              :model="model"
              :models="modelOptions"
              :reasoning-effort="reasoningEffort"
              :reasoning-options="showReasoningControl ? reasoningOptions : []"
              :default-reasoning-effort="defaultReasoningEffort"
              :disabled="loading"
              :saving="modelPreferenceSaving"
              @update:model="emit('update:model', $event)"
              @update:reasoning-effort="emit('update:reasoningEffort', $event)"
            />
          </div>

          <button
            :class="sendButtonClasses"
            :disabled="loading ? stopDisabled : !canSend"
            type="button"
            v-tooltip="loading ? $t('ui.stopGenerating') : $t('ui.send')"
            @click="handleAction"
          >
            <ArrowUp v-if="!loading" :size="18" />
            <Square v-else :size="11" fill="currentColor" stroke-width="0" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "tailwindcss";

.send-button-active {
  background-color: var(--color-primary);
}

.send-button-active:hover {
  background-color: var(--color-primary-hover);
}
</style>
