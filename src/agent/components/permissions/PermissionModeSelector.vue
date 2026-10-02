<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, type Component } from 'vue';
import { Check, ChevronDown, FileCheck2, Hand, ListChecks, ShieldAlert } from '@lucide/vue';

import FloatingMenu from '../../../components/FloatingMenu.vue';
import type { AgentPermissionMode } from '../../types';

interface PermissionModeOption {
  value: AgentPermissionMode;
  label: string;
  description: string;
  icon: Component;
  dangerous?: boolean;
}

const props = defineProps<{
  modelValue: AgentPermissionMode;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: AgentPermissionMode];
}>();

const options = computed<PermissionModeOption[]>(() => [
  {
    value: 'plan',
    label: tr('ui.plan'),
    description: tr('ui.analyzeReadAndSearchWithoutMaking'),
    icon: ListChecks,
  },
  {
    value: 'ask',
    label: tr('ui.ask'),
    description: tr('ui.alwaysAskBeforeWritingDeletingOr'),
    icon: Hand,
  },
  {
    value: 'accept_edits',
    label: tr('ui.edit'),
    description: tr('ui.allowFileEditsAndLowRisk'),
    icon: FileCheck2,
  },
  {
    value: 'full_access',
    label: tr('ui.fullAccess'),
    description: tr('ui.accessTheInternetAndAnyFile'),
    icon: ShieldAlert,
    dangerous: true,
  },
]);

const selectedOption = computed(
  () => options.value.find((option) => option.value === props.modelValue) || options.value[2],
);
</script>

<template>
  <FloatingMenu placement="top-start" menu-class="permission-menu-shell">
    <template #trigger>
      <button
        class="permission-trigger"
        :class="selectedOption.dangerous ? 'permission-trigger-danger' : ''"
        :disabled="disabled"
        type="button"
        v-tooltip="$t('ui.chooseAgentPermissionsForThisTurn')"
      >
        <component :is="selectedOption.icon" :size="15" class="shrink-0" />
        <span class="truncate">{{ selectedOption.label }}</span>
        <ChevronDown :size="13" class="shrink-0 opacity-60" />
      </button>
    </template>

    <template #menu>
      <div class="w-88 max-w-[calc(100vw-1rem)] py-1">
        <div class="px-3 pb-1.5 pt-1 text-xs text-gray-400">
          {{ $t('ui.howShouldTheAgentPerformActions') }}
        </div>
        <button
          v-for="option in options"
          :key="option.value"
          class="permission-option"
          :class="[
            option.value === modelValue ? 'bg-gray-50' : '',
            option.dangerous ? 'permission-option-danger' : '',
          ]"
          type="button"
          @click="emit('update:modelValue', option.value)"
        >
          <component :is="option.icon" :size="16" class="mt-0.5 shrink-0" />
          <span class="min-w-0 flex-1 text-left">
            <span class="block text-sm font-medium leading-5">{{ option.label }}</span>
            <span
              class="block text-xs leading-4"
              :class="option.dangerous ? 'text-orange-500' : 'text-gray-400'"
            >
              {{ option.description }}
            </span>
          </span>
          <Check v-if="option.value === modelValue" :size="16" class="mt-1 shrink-0" />
        </button>
      </div>
    </template>
  </FloatingMenu>
</template>

<style scoped>
@reference "tailwindcss";

:global(.permission-menu-shell) {
  padding: 0.25rem;
}

.permission-trigger {
  @apply flex h-9 max-w-40 items-center gap-1.5 rounded-full px-3 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-50;
}

.permission-trigger-danger {
  @apply text-orange-500 hover:bg-orange-50 hover:text-orange-600;
}

.permission-option {
  @apply flex w-full items-start gap-3 rounded-xl px-3 py-2 text-gray-700 transition-colors hover:bg-gray-50;
}

.permission-option-danger {
  @apply text-orange-500 hover:bg-orange-50;
}
</style>
