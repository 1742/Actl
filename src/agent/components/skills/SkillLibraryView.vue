<script setup lang="ts">
import { Package } from '@lucide/vue';
</script>

<template>
  <div class="flex h-full items-center justify-center bg-white p-8">
    <div class="max-w-sm text-center">
      <div
        class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100 text-gray-600"
      >
        <Package :size="23" :stroke-width="1.6" />
      </div>
      <h1 class="text-lg font-semibold text-gray-900">Skills</h1>
      <p class="mt-2 text-sm leading-6 text-gray-500">{{ $t('ui.selectAnInstalledSkillOnThe') }}</p>
    </div>
  </div>
</template>
