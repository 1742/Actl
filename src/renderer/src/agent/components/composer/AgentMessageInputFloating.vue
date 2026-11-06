<template>
  <AgentMessageInputCore
    :model-value="props.modelValue"
    :model="props.model"
    :model-options="props.modelOptions"
    :reasoning-effort="props.reasoningEffort"
    :reasoning-options="props.reasoningOptions"
    :show-reasoning-control="props.showReasoningControl"
    :placeholder="props.placeholder"
    :loading="props.loading"
    :stop-disabled="props.stopDisabled"
    :disabled="props.disabled"
    :can-submit="props.canSubmit"
    :hide-composer="props.hideComposer"
    :variant="props.variant"
    container-class="py-2"
    shell-class="rounded-2xl shadow-lg shadow-black/10"
    :layout-key="props.layoutKey"
    @update:model="emit('update:model', $event)"
    @update:reasoning-effort="emit('update:reasoningEffort', $event)"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="emit('submit', $event)"
    @stop="emit('stop')"
    @height-change="emit('heightChange', $event)"
    @keydown="emit('keydown', $event)"
  >
    <template #attachments><slot name="attachments" /></template>
    <template #editor="slotProps"><slot name="editor" v-bind="slotProps" /></template>
    <template #left-tools><slot name="left-tools" /></template>
  </AgentMessageInputCore>
</template>

<script setup lang="ts">
import AgentMessageInputCore, { type AgentMessageInputProps } from "./AgentMessageInputCore.vue";

defineOptions({ inheritAttrs: false });
const props = defineProps<AgentMessageInputProps>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:model": [value: string];
  "update:reasoningEffort": [value: string];
  submit: [value: string];
  stop: [];
  heightChange: [height: number];
  keydown: [event: KeyboardEvent];
}>();
</script>
