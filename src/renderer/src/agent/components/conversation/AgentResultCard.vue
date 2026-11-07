<script setup lang="ts">
withDefaults(defineProps<{ expanded?: boolean }>(), { expanded: undefined });
defineEmits<{ toggle: [] }>();
</script>

<template>
  <section class="w-full min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white text-sm">
    <component
      :is="expanded === undefined ? 'header' : 'button'"
      class="flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left"
      :class="{ 'hover:bg-gray-50': expanded !== undefined }"
      :type="expanded === undefined ? undefined : 'button'"
      :aria-expanded="expanded"
      @click="expanded !== undefined && $emit('toggle')"
    >
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
        <slot name="icon" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate font-medium text-gray-900"><slot name="title" /></span>
        <slot name="detail" />
      </span>
      <slot name="action" />
    </component>
    <div v-if="$slots.default" class="border-t border-gray-100">
      <slot />
    </div>
  </section>
</template>

<style scoped>
@reference "tailwindcss";

:deep(.agent-result-row) {
  @apply flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-xs hover:bg-gray-50;
}
</style>
