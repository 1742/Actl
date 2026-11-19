<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ body?: string | undefined; fields?: Array<{ label: string; value: string }> | undefined }>();
const visibleFields = computed(() => props.fields?.filter(({ value }) => value));
</script>

<template>
  <p v-if="body" class="mt-1 whitespace-pre-wrap wrap-anywhere text-gray-700">{{ body }}</p>
  <dl v-if="visibleFields?.length" class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
    <template v-for="{ label, value } in visibleFields" :key="label">
      <dt class="text-gray-500">{{ label }}</dt>
      <dd class="whitespace-pre-wrap wrap-anywhere text-gray-700">{{ value }}</dd>
    </template>
  </dl>
</template>
