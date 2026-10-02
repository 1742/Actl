<script setup lang="ts">
import { computed } from 'vue';

import { md } from '../../../utils/markdown';
import { theme } from '../../../composables/theme';

const props = defineProps<{
  htmlString: string;
  isInvert: boolean;
}>();

const html = computed(() => md.render(props.htmlString));
const invertedProse = computed(() => props.isInvert || theme.value === 'dark');

const handleContentClick = (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('.code-copy-btn');
  if (!(button instanceof HTMLButtonElement)) return;

  const code = button.getAttribute('data-clipboard-text');
  if (!code) return;

  navigator.clipboard.writeText(code).then(() => {
    const originalHtml = button.innerHTML;
    button.innerHTML = `<svg class="w-3.5 h-3.5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6 9 17l-5-5"/></svg> <span class="text-primary">Copied!</span>`;
    button.classList.add('copied');
    setTimeout(() => {
      button.innerHTML = originalHtml;
      button.classList.remove('copied');
    }, 2000);
  });
};
</script>

<template>
  <div
    class="text-content prose prose-sm sm:prose-base max-w-none overflow-hidden prose-p:my-1"
    :class="[
      !invertedProse ? 'prose-slate' : '',
      invertedProse ? 'prose-invert text-inherit message-html-dark' : '',
    ]"
    @click="handleContentClick"
    v-html="html"
  />
</template>

<style scoped>
@reference "tailwindcss";

:deep(.prose-invert) {
  --tw-prose-body: inherit;
  --tw-prose-headings: inherit;
  --tw-prose-links: inherit;
  --tw-prose-bold: inherit;
  --tw-prose-counters: inherit;
  --tw-prose-bullets: inherit;
}

:deep(.katex-display) {
  @apply max-w-full overflow-x-auto overflow-y-hidden py-2 my-2 text-center;
}

:deep(.katex) {
  @apply text-[1.05em];
}

:deep(p),
:deep(li),
:deep(blockquote),
:deep(h1),
:deep(h2),
:deep(h3),
:deep(h4) {
  overflow-wrap: anywhere;
}

:deep(img),
:deep(video),
:deep(svg) {
  max-width: 100%;
}

:deep(.table-scroll-wrapper) {
  @apply my-4 max-w-full overflow-x-auto;
}

:deep(table) {
  width: 100%;
  min-width: max-content;
  border-collapse: collapse;
  @apply my-0! border border-gray-200;
}

:deep(thead) {
  @apply bg-gray-50/80;
}

:deep(th) {
  @apply border border-gray-200 px-4 py-2.5 text-left font-bold text-gray-700 bg-gray-50/50;
  white-space: nowrap;
}

:deep(td) {
  @apply border border-gray-200 px-4 py-2 text-gray-600 leading-relaxed;
  word-break: break-word;
}

:deep(:not(pre) > code) {
  @apply bg-gray-100 text-gray-800 px-1.5 py-0.5 rounded font-mono text-[0.9em] mx-0.5 before:content-none after:content-none;
}

:deep(.code-block-wrapper) {
  @apply my-4 rounded-lg border border-gray-200 bg-white overflow-hidden shadow-sm;
}

:deep(.code-header) {
  @apply flex justify-between items-center px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 font-sans;
}

:deep(.code-lang) {
  @apply min-w-0 truncate tracking-wider text-gray-400;
}

:deep(.code-copy-btn) {
  @apply flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors hover:bg-gray-200/50 hover:text-gray-800 active:scale-95;
}

:deep(pre) {
  @apply m-0! bg-transparent! p-3! overflow-x-auto;
}

:deep(code) {
  @apply font-mono text-[13px] leading-relaxed;
}

:deep(.hljs) {
  @apply bg-transparent! text-gray-800;
}

.message-html-dark :deep(.hljs-comment),
.message-html-dark :deep(.hljs-quote) {
  color: #9aa4b3;
}

.message-html-dark :deep(.hljs-doctag),
.message-html-dark :deep(.hljs-keyword),
.message-html-dark :deep(.hljs-formula) {
  color: #c792ea;
}

.message-html-dark :deep(.hljs-section),
.message-html-dark :deep(.hljs-name),
.message-html-dark :deep(.hljs-selector-tag),
.message-html-dark :deep(.hljs-deletion),
.message-html-dark :deep(.hljs-subst) {
  color: #f28b91;
}

.message-html-dark :deep(.hljs-literal) {
  color: #86d4df;
}

.message-html-dark :deep(.hljs-string),
.message-html-dark :deep(.hljs-regexp),
.message-html-dark :deep(.hljs-addition),
.message-html-dark :deep(.hljs-attribute),
.message-html-dark :deep(.hljs-meta .hljs-string) {
  color: #a8d69d;
}

.message-html-dark :deep(.hljs-attr),
.message-html-dark :deep(.hljs-variable),
.message-html-dark :deep(.hljs-template-variable),
.message-html-dark :deep(.hljs-type),
.message-html-dark :deep(.hljs-selector-class),
.message-html-dark :deep(.hljs-selector-attr),
.message-html-dark :deep(.hljs-selector-pseudo),
.message-html-dark :deep(.hljs-number) {
  color: #e3b47d;
}

.message-html-dark :deep(.hljs-symbol),
.message-html-dark :deep(.hljs-bullet),
.message-html-dark :deep(.hljs-link),
.message-html-dark :deep(.hljs-meta),
.message-html-dark :deep(.hljs-selector-id),
.message-html-dark :deep(.hljs-title) {
  color: #83baff;
}

.message-html-dark :deep(.hljs-built_in),
.message-html-dark :deep(.hljs-title.class_),
.message-html-dark :deep(.hljs-class .hljs-title) {
  color: #edcd86;
}

:deep(.katex-display),
:deep(.table-scroll-wrapper),
:deep(pre) {
  scrollbar-width: thin;
  scrollbar-color: rgb(203 213 225 / 0.75) transparent;
}

:deep(.katex-display::-webkit-scrollbar),
:deep(.table-scroll-wrapper::-webkit-scrollbar),
:deep(pre::-webkit-scrollbar) {
  width: 4px;
  height: 4px;
}

:deep(.katex-display::-webkit-scrollbar-track),
:deep(.table-scroll-wrapper::-webkit-scrollbar-track),
:deep(pre::-webkit-scrollbar-track) {
  background: transparent;
}

:deep(.katex-display::-webkit-scrollbar-thumb),
:deep(.table-scroll-wrapper::-webkit-scrollbar-thumb),
:deep(pre::-webkit-scrollbar-thumb) {
  background-color: rgb(203 213 225 / 0.75);
  border-radius: 999px;
}

:deep(.katex-display::-webkit-scrollbar-thumb:hover),
:deep(.table-scroll-wrapper::-webkit-scrollbar-thumb:hover),
:deep(pre::-webkit-scrollbar-thumb:hover) {
  background-color: rgb(148 163 184 / 0.9);
}
</style>
