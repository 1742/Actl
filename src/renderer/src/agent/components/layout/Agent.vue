<script setup lang="ts">
import { computed, provide, shallowRef } from 'vue';
import { useRouter } from "vue-router";

import AgentMessages from "../conversation/MessagesArea.vue";
import AgentInput from "../composer/Input.vue";
import AgentTreePermissions from '../permissions/AgentTreePermissions.vue';
import AgentTopBar from "./AgentTopBar.vue";
import RightSidebarContainer from "../right-sidebar/AgentSidebarContainer.vue";
import { reviewTargetKey, type ReviewTarget } from '../review/reviewNavigation';
import { agentTreeKey, useAgentTree } from '../../composables/useAgentTree';
import { useAgentStore } from '../../stores/agent';

const emit = defineEmits<{
  openNavSidebar: [];
}>();
const router = useRouter();
const store = useAgentStore();
const isArchived = computed(() => store.isSessionArchived(store.selectedSessionId));
provide(reviewTargetKey, shallowRef<ReviewTarget>());
provide(agentTreeKey, useAgentTree());

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

      <div v-if="isArchived"
        class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-gray-200 px-4 py-3 text-sm text-gray-500">
        <span>{{ $t('ui.restoreBeforeContinuing') }}</span>
        <button type="button" class="font-medium text-primary hover:underline"
          @click="router.push({ name: 'aiAgentSettings', query: { section: 'archived' } })">
          {{ $t('settings.sections.archived') }}
        </button>
      </div>
      <AgentInput v-else-if="!store.session?.parentSessionId" />
      <div v-else class="mx-auto w-full max-w-5xl shrink-0 px-4 sm:px-6 lg:px-8">
        <AgentTreePermissions />
        <p class="px-4 py-3 text-center text-sm text-gray-500">{{ $t('agents.sendInParentConversation') }}</p>
      </div>
    </section>

    <RightSidebarContainer class="shrink-0" />
  </div>
</template>
