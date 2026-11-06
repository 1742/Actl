<script setup lang="ts">
import { useRouter } from "vue-router";

import AgentMessages from "../conversation/MessagesArea.vue";
import AgentInput from "../composer/Input.vue";
import AgentTopBar from "./AgentTopBar.vue";
import RightSidebarContainer from "./AgentSidebarContainer.vue";

const emit = defineEmits<{
  openNavSidebar: [];
}>();
const router = useRouter();

async function toggleRightSidebar() {
  const target = "aiAgentRightSidebarHome";
  await router.push({ name: router.currentRoute.value.name === target ? "aiAgent" : target });
}

</script>

<template>
  <div class="relative flex h-full w-full max-w-full overflow-hidden bg-transparent">
    <section class="relative flex h-full min-w-0 max-w-full flex-1 flex-col overflow-hidden">
      <AgentTopBar @open-nav-sidebar="emit('openNavSidebar')" @toggle-right-sidebar="toggleRightSidebar" />
      <AgentMessages :bottom-inset="0" />

      <AgentInput />
    </section>

    <RightSidebarContainer class="shrink-0" />
  </div>
</template>
