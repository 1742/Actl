<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUp, Check, ChevronDown, ChevronRight, Square } from '@lucide/vue';

import FloatingMenu from '../../../components/FloatingMenu.vue';

export interface AIMessageInputModelOption {
  label: string;
  value: string;
}

export interface AIMessageInputReasoningOption {
  label: string;
  value: string;
  description?: string;
}

export interface AgentMessageInputProps {
  modelValue?: string;
  model: string;
  modelOptions?: AIMessageInputModelOption[];
  reasoningEffort?: string;
  reasoningOptions?: AIMessageInputReasoningOption[];
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
  'update:reasoningEffort': [value: string];
  submit: [value: string];
  stop: [];
  heightChange: [height: number];
  keydown: [event: KeyboardEvent];
}>();

const containerRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const configurationMenuRef = ref<{ close: () => void } | null>(null);
const configurationRootMenuRef = ref<HTMLElement | null>(null);
const configurationOptionsMenuRef = ref<HTMLElement | null>(null);
const configurationMenuContentRef = ref<HTMLElement | null>(null);
const configurationMenuOpen = ref(false);
const modelMenuOpen = ref(false);
const activeConfigurationPanel = ref<'model' | 'reasoning' | null>(null);
const configurationPanelPlacement = ref<'left' | 'right' | 'stacked'>('right');
const MIN_TEXTAREA_HEIGHT = 48;
const MAX_TEXTAREA_HEIGHT = 180;
let heightFrame = 0;
let lastTextareaHeight = 0;
let lastContainerHeight = 0;
let containerResizeObserver: ResizeObserver | undefined;
let configurationLayoutFrame = 0;

const isDark = computed(() => props.variant === 'dark');
const trimmedText = computed(() => props.modelValue.trim());
const hasModelOptions = computed(() => props.modelOptions.length > 0);
const hasReasoningOptions = computed(() => props.reasoningOptions.length > 0);
const selectedModelLabel = computed(
  () => props.modelOptions.find((option) => option.value === props.model)?.label || props.model,
);
const selectedReasoningLabel = computed(
  () =>
    props.reasoningOptions.find((option) => option.value === props.reasoningEffort)?.label ||
    props.reasoningEffort ||
    '',
);
const configurationTriggerLabel = computed(() =>
  [selectedModelLabel.value, selectedReasoningLabel.value].filter(Boolean).join(' '),
);
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

let configurationPanelCloseTimer: number | undefined;

const isPointerInsideConfigurationMenu = (x: number, y: number) => {
  const root = configurationRootMenuRef.value;
  const options = configurationOptionsMenuRef.value;
  const rects = [root, options]
    .filter((el): el is HTMLElement => Boolean(el))
    .map((el) => el.getBoundingClientRect());
  if (!rects.length) return false;
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return x >= left && x <= right && y >= top && y <= bottom;
};

const scheduleConfigurationPanelClose = (event?: MouseEvent) => {
  // 指针仍在弹出框区域（根菜单与选项面板的并集）内时保持打开，
  // 避免斜向移动、间隙停顿或菜单位置微调时误关闭。
  if (event && isPointerInsideConfigurationMenu(event.clientX, event.clientY)) {
    window.clearTimeout(configurationPanelCloseTimer);
    return;
  }
  window.clearTimeout(configurationPanelCloseTimer);
  configurationPanelCloseTimer = window.setTimeout(() => {
    activeConfigurationPanel.value = null;
  }, 300);
};

const cancelConfigurationPanelClose = () => {
  window.clearTimeout(configurationPanelCloseTimer);
};

let lastPointerX = 0;
let lastPointerY = 0;

// 全局跟踪指针：面板打开期间，指针一旦离开弹出框区域（根菜单 ∪ 选项面板）就安排关闭；
// 在区域内则始终取消关闭，保证移入面板后不会因间隙、停顿或菜单微调而消失。
const trackConfigurationPointer = (event: MouseEvent) => {
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  if (!activeConfigurationPanel.value) return;
  if (isPointerInsideConfigurationMenu(lastPointerX, lastPointerY)) {
    window.clearTimeout(configurationPanelCloseTimer);
    return;
  }
  window.clearTimeout(configurationPanelCloseTimer);
  configurationPanelCloseTimer = window.setTimeout(() => {
    activeConfigurationPanel.value = null;
  }, 200);
};

const selectModel = (model: string) => {
  emit('update:model', model);
  activeConfigurationPanel.value = null;
  configurationMenuRef.value?.close();
};

const selectReasoningEffort = (effort: string) => {
  emit('update:reasoningEffort', effort);
  activeConfigurationPanel.value = null;
  configurationMenuRef.value?.close();
};

const updateConfigurationPanelPlacement = () => {
  if (configurationLayoutFrame) cancelAnimationFrame(configurationLayoutFrame);
  configurationLayoutFrame = requestAnimationFrame(() => {
    configurationLayoutFrame = 0;
    const menu = configurationMenuContentRef.value;
    if (!menu || !activeConfigurationPanel.value) return;

    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const panelWidth = 192;
    const panelGap = 8;
    const viewportPadding = 8;
    const requiredSpace = panelWidth + panelGap + viewportPadding;

    if (viewportWidth < panelWidth + viewportPadding * 2) {
      configurationPanelPlacement.value = 'stacked';
    } else if (viewportWidth - rect.right < requiredSpace && rect.left >= requiredSpace) {
      configurationPanelPlacement.value = 'left';
    } else if (viewportWidth - rect.right < requiredSpace) {
      configurationPanelPlacement.value = 'stacked';
    } else {
      configurationPanelPlacement.value = 'right';
    }
  });
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
watch(activeConfigurationPanel, async (panel) => {
  if (!panel) return;
  await nextTick();
  updateConfigurationPanelPlacement();
});

onMounted(() => {
  scheduleInputHeight();
  window.addEventListener('mousemove', trackConfigurationPointer);
  window.addEventListener('resize', updateConfigurationPanelPlacement);
  if (containerRef.value && typeof ResizeObserver !== 'undefined') {
    containerResizeObserver = new ResizeObserver(() => scheduleInputHeight());
    containerResizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  if (heightFrame) cancelAnimationFrame(heightFrame);
  if (configurationLayoutFrame) cancelAnimationFrame(configurationLayoutFrame);
  window.removeEventListener('resize', updateConfigurationPanelPlacement);
  containerResizeObserver?.disconnect();
  window.removeEventListener('mousemove', trackConfigurationPointer);
  window.clearTimeout(configurationPanelCloseTimer);
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

        <div class="flex min-h-10 shrink-0 items-center justify-between gap-3">
          <div class="flex items-center gap-1">
            <slot name="left-tools" />
          </div>

          <div class="min-w-0 flex-1" />

          <div v-if="hasModelOptions" class="hidden sm:block">
            <FloatingMenu
              v-if="showReasoningControl"
              ref="configurationMenuRef"
              placement="top-end"
              :close-on-menu-click="false"
              @update:open="configurationMenuOpen = $event"
            >
              <template #trigger>
                <button
                  class="model-trigger"
                  :disabled="loading"
                  type="button"
                  v-tooltip="{
                    content: $t('ui.chooseAModelAndReasoningEffort'),
                    popperTriggers: ['hover'],
                    delay: { show: 200, hide: 300 },
                    disabled: configurationMenuOpen,
                  }"
                  @click="activeConfigurationPanel = null"
                >
                  <span class="truncate">{{ configurationTriggerLabel }}</span>
                  <ChevronDown :size="14" class="shrink-0 text-gray-400" />
                </button>
              </template>
              <template #menu>
                <div
                  ref="configurationMenuContentRef"
                  class="configuration-menu"
                  @mouseleave="scheduleConfigurationPanelClose"
                  @mouseenter="cancelConfigurationPanelClose"
                >
                  <div ref="configurationRootMenuRef" class="configuration-root-menu">
                    <button
                      class="configuration-root-item"
                      :class="activeConfigurationPanel === 'model' ? 'bg-gray-100' : ''"
                      type="button"
                      @mouseenter="activeConfigurationPanel = 'model'"
                      @click="activeConfigurationPanel = 'model'"
                    >
                      <span class="font-medium text-gray-800">{{ $t('ui.model') }}</span>
                      <span class="ml-auto max-w-24 truncate text-gray-400">{{
                        selectedModelLabel
                      }}</span>
                      <ChevronRight :size="15" class="shrink-0 text-gray-400" />
                    </button>
                    <button
                      class="configuration-root-item"
                      :class="[
                        activeConfigurationPanel === 'reasoning' ? 'bg-gray-100' : '',
                        !hasReasoningOptions ? 'configuration-root-item-disabled' : '',
                      ]"
                      :aria-disabled="!hasReasoningOptions"
                      type="button"
                      @mouseenter="
                        activeConfigurationPanel = hasReasoningOptions ? 'reasoning' : null
                      "
                      @click="hasReasoningOptions && (activeConfigurationPanel = 'reasoning')"
                    >
                      <span class="font-medium text-gray-800">{{ $t('ui.reasoningEffort') }}</span>
                      <span class="ml-auto text-gray-400">{{ selectedReasoningLabel }}</span>
                      <ChevronRight :size="15" class="shrink-0 text-gray-400" />
                    </button>
                  </div>

                  <div
                    ref="configurationOptionsMenuRef"
                    v-if="activeConfigurationPanel"
                    class="configuration-options-menu"
                    :class="`configuration-options-menu-${configurationPanelPlacement}`"
                  >
                    <template v-if="activeConfigurationPanel === 'model'">
                      <div class="configuration-panel-title">{{ $t('ui.model') }}</div>
                      <button
                        v-for="option in modelOptions"
                        :key="option.value"
                        class="configuration-option"
                        type="button"
                        @click="selectModel(option.value)"
                      >
                        <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
                        <Check
                          v-if="option.value === model"
                          :size="16"
                          class="shrink-0 text-gray-800"
                        />
                      </button>
                    </template>
                    <template v-else>
                      <div class="configuration-panel-title">{{ $t('ui.reasoningEffort') }}</div>
                      <button
                        v-for="option in reasoningOptions"
                        :key="option.value"
                        class="configuration-option items-start"
                        type="button"
                        @click="selectReasoningEffort(option.value)"
                      >
                        <span class="min-w-0 flex-1 text-left">
                          <span class="block">{{ option.label }}</span>
                          <span
                            v-if="option.description"
                            class="mt-0.5 block text-xs leading-4 text-gray-400"
                            >{{ option.description }}</span
                          >
                        </span>
                        <Check
                          v-if="option.value === reasoningEffort"
                          :size="16"
                          class="mt-0.5 shrink-0 text-gray-800"
                        />
                      </button>
                    </template>
                  </div>
                </div>
              </template>
            </FloatingMenu>

            <FloatingMenu v-else placement="top-end" @update:open="modelMenuOpen = $event">
              <template #trigger>
                <button
                  class="model-trigger"
                  :disabled="loading"
                  type="button"
                  v-tooltip="{
                    content: $t('ui.chooseModel'),
                    popperTriggers: ['hover'],
                    delay: { show: 200, hide: 300 },
                    disabled: modelMenuOpen,
                  }"
                >
                  <span class="truncate">{{ selectedModelLabel }}</span>
                  <ChevronDown :size="14" class="shrink-0 text-gray-400" />
                </button>
              </template>
              <template #menu>
                <div class="model-menu">
                  <button
                    v-for="option in modelOptions"
                    :key="option.value"
                    class="model-menu-item"
                    type="button"
                    @click="selectModel(option.value)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </template>
            </FloatingMenu>
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

.model-trigger {
  @apply flex h-9 max-w-50 items-center gap-1.5 rounded-full border-0 py-0 pl-4 pr-3 text-sm text-gray-500 outline-none transition-colors hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-60;
}

.model-menu {
  @apply flex min-w-32 flex-col p-1 text-sm;
}

.model-menu-item {
  @apply flex h-9 w-full items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-gray-50 hover:cursor-pointer;
}

.configuration-menu {
  @apply relative text-sm;
}

.configuration-menu::after {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 100%;
  width: 0.5rem;
  content: '';
}

.configuration-root-menu {
  @apply w-48 p-1;
}

.configuration-root-item {
  @apply flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-gray-100;
}

.configuration-root-item-disabled {
  @apply cursor-not-allowed text-gray-300 hover:bg-transparent;
}

.configuration-root-item-disabled > span,
.configuration-root-item-disabled > svg {
  @apply text-gray-300;
}

.configuration-options-menu {
  @apply absolute bottom-0 max-h-80 w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-1 shadow-xl shadow-black/10;
}

.configuration-options-menu-right {
  left: calc(100% + 0.5rem);
}

.configuration-options-menu-left {
  right: calc(100% + 0.5rem);
}

.configuration-options-menu-stacked {
  right: 0;
  bottom: calc(100% + 0.5rem);
}

.configuration-panel-title {
  @apply px-2 pb-1 pt-1.5 text-xs font-medium text-gray-400;
}

.configuration-option {
  @apply flex min-h-9 w-full gap-3 rounded-lg px-2 py-2 text-gray-800 transition-colors hover:cursor-pointer hover:bg-gray-50;
}
</style>
