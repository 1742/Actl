<script setup lang="ts">
import { computed } from 'vue';
import type { AIMessageItem } from '../../types/aiResponse.ts';
import { readContentText } from '../../utils/aiResponse.ts';
import MessageHtml from './MessageHtml.vue';
import MessageTools from './MessageTools.vue';

const props = withDefaults(
  defineProps<{
    item: AIMessageItem;
    showTools?: boolean;
  }>(),
  {
    showTools: true,
  },
);
const text = computed(() => readContentText(props.item.content, 'output_text'));
</script>

<template>
  <div v-if="text" class="flex flex-col items-start text-gray-900 group">
    <div class="w-full text-[15px] leading-7 text-gray-950">
      <MessageHtml :html-string="text" :is-invert="false" />
    </div>
    <slot name="footer" :content="text">
      <MessageTools v-if="showTools" :content="text" />
    </slot>
  </div>
</template>
