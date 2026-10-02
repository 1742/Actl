<script setup lang="ts">
import { tr } from '../../../i18n';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, FileCode2, FolderOpen, LoaderCircle } from '@lucide/vue';
import { useRuntimeStore } from '../../../stores/runtime';
import { fetchSkillDetail, type SkillDetail } from '../../services/skills/service';
import { skillsRefreshVersion } from '../layout/libraryNavigation';

const props = defineProps<{ skillId: string }>();
const router = useRouter();
const runtime = useRuntimeStore();
const skill = ref<SkillDetail>();
const loading = ref(false);
const error = ref('');

const files = computed(() => skill.value?.files?.entries ?? []);

function depth(filePath: string) {
  return filePath.split('/').length - 1;
}

function fileIcon(type: 'file' | 'directory') {
  return type === 'directory' ? FolderOpen : FileCode2;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    skill.value = await fetchSkillDetail(runtime.agentUrl, props.skillId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : tr('ui.couldNotLoadSkillDetails');
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.skillId,
  () => {
    void load();
  },
);
watch(skillsRefreshVersion, () => {
  void load();
});
onMounted(() => {
  void load();
});
</script>

<template>
  <div class="flex h-full w-full flex-col overflow-hidden bg-white">
    <div v-if="loading" class="flex flex-1 items-center justify-center gap-2 text-sm text-gray-500">
      <LoaderCircle :size="16" class="animate-spin" /> {{ $t('ui.loadingSkill') }}
    </div>
    <div
      v-else-if="error"
      class="m-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700"
    >
      {{ error }}
    </div>

    <main v-else-if="skill" class="min-h-0 flex-1 overflow-y-auto">
      <section class="px-8 pt-8">
        <div class="mx-auto max-w-5xl">
          <div class="min-w-0">
            <div class="flex items-center gap-4">
              <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  class="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100"
                  :title="$t('ui.backToSkills')"
                  @click="router.push({ name: 'aiSkills' })"
                >
                  <ArrowLeft :size="19" />
                </button>
                <h1 class="truncate font-mono text-2xl font-semibold tracking-tight text-gray-900">
                  {{ skill.name }}
                </h1>
                <span v-if="skill.version" class="text-sm text-gray-400">v{{ skill.version }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-5xl px-8 py-5">
        <section>
          <div v-if="skill.languages?.length" class="mb-2 flex flex-wrap items-center gap-1.5">
            <span
              v-for="language in skill.languages"
              :key="language"
              class="rounded-md bg-sky-50 px-2 py-1 text-xs text-sky-700"
              >{{ language }}</span
            >
          </div>
          <p class="text-sm leading-6 text-gray-600">{{ skill.description }}</p>
          <h2 class="mt-6 text-base font-semibold text-gray-900">{{ $t('ui.files') }}</h2>
          <div v-if="files.length" class="mt-4 overflow-hidden rounded-xl border border-gray-200">
            <div
              v-for="entry in files"
              :key="entry.path"
              class="flex items-center gap-2 border-b border-gray-100 py-2 pr-3 last:border-b-0"
              :style="{ paddingLeft: `${12 + depth(entry.path) * 18}px` }"
            >
              <component
                :is="fileIcon(entry.type)"
                :size="15"
                :class="entry.type === 'directory' ? 'text-amber-500' : 'text-gray-400'"
              />
              <span class="font-mono text-xs text-gray-700">{{
                entry.path.split('/').at(-1)
              }}</span>
            </div>
          </div>
          <p
            v-else
            class="mt-4 rounded-xl border border-dashed border-gray-200 p-4 text-sm text-gray-400"
          >
            {{ $t('ui.noAdditionalFilesToDisplay') }}
          </p>
        </section>
      </div>
    </main>
  </div>
</template>
