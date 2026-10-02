<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed } from 'vue';
import { AlertCircle } from '@lucide/vue';
import AIResponseConversation from '../responses/AIResponseConversation.vue';
import type { AIFileContent } from '../../types/aiResponse.ts';
import { useNotifyStore } from '../../../composables/notify';
import { downloadAgentFile } from '../../composables/useAgent';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent.ts';
import { projectName } from '../../utils';
import AgentResponseOutput from './AgentResponseOutput.vue';

withDefaults(defineProps<{ bottomInset?: number }>(), { bottomInset: 140 });
const agentStore = useAgentStore();
const notify = useNotifyStore();
const emptyText = computed(() => {
  if (agentStore.selectedSessionId) return tr('ui.whatCanIHelpYouWith');
  const project = agentStore.draftProject;
  return project
    ? tr('dynamic.workspaceQuestion', { name: projectName(project.cwd, project.name) })
    : tr('ui.createOrSelectAConversationTo');
});
const skillNames = computed(() =>
  Object.fromEntries(agentStore.skills.map((skill) => [skill.id, skill.name])),
);

async function downloadFile(file: AIFileContent) {
  const result = await downloadAgentFile(file);
  if (result.status === 'error') notify.error(result.message || tr('ui.downloadFailed'));
}

async function loadFilePreview(file: AIFileContent, sessionId: string) {
  const fileId = typeof file.file_id === 'string' ? file.file_id : '';
  if (!fileId) return undefined;
  const session =
    agentStore.sessions.find((item) => item.id === agentStore.selectedSessionId) ??
    agentStore.sessions.find((item) => item.runtimeId === sessionId);
  if (!session) return undefined;
  const { client } = getAgentRuntimeContext(session.runtimeKind);
  const blob = await client.getFileContent(session.runtimeId, fileId);
  return URL.createObjectURL(blob);
}
</script>

<template>
  <AIResponseConversation
    :contexts="agentStore.responses"
    :bottom-inset="bottomInset"
    :empty-text="emptyText"
    :skill-names="skillNames"
    :load-file-preview="loadFilePreview"
    :compressions="agentStore.currentRuntime?.context?.compressions || []"
    :compression-in-progress="agentStore.currentRuntime?.compressionInProgress || false"
    @download-file="downloadFile"
  >
    <template #output="{ context }">
      <AgentResponseOutput :context="context" />
    </template>
    <div
      v-if="agentStore.errorMessage"
      class="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600"
    >
      <AlertCircle :size="16" class="mt-0.5 shrink-0" />
      <span>{{ agentStore.errorMessage }}</span>
    </div>
  </AIResponseConversation>
</template>
