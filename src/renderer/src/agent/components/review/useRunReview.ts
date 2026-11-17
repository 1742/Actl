import { computed, ref, shallowRef, watch, type ShallowRef } from 'vue';
import type { ReviewLine, SessionReview } from '../../../../../shared/agent/review';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { RuntimeSession } from '../navigation/types';
import { useTreeReviewTarget, type ReviewTarget } from './reviewNavigation';

export function useRunReview(request?: Readonly<ShallowRef<ReviewTarget | undefined>>) {
  const store = useAgentStore();
  const target = useTreeReviewTarget(request);
  const session = computed(() => target.value ? store.sessionById(target.value.sessionId) : store.session);
  const latest = computed(() => target.value ? undefined : store.responses.at(-1)?.response);
  const loaded = shallowRef<{ owner: RuntimeSession; review: SessionReview }>();
  const review = computed(() => loaded.value?.owner.id === session.value?.id ? loaded.value?.review : undefined);
  const lines = shallowRef<ReviewLine[]>([]);
  const selectedId = ref('');
  const loading = ref(false);
  const loadingDiff = ref(false);
  const failed = ref(false);
  const diffFailed = ref(false);
  const refresh = ref(0);
  const selectedFile = computed(() => review.value?.files.find((file) => file.id === selectedId.value));

  watch([() => session.value?.id, target, () => latest.value?.id, () => latest.value?.status, refresh], async ([, requested], _, onCleanup) => {
    let current = true;
    onCleanup(() => { current = false; });
    const owner = session.value;
    const previousId = loaded.value?.owner.id === owner?.id ? selectedId.value : '';
    loaded.value = undefined;
    selectedId.value = '';
    failed.value = false;
    loading.value = Boolean(owner);
    if (!owner) return;
    try {
      const { client } = getAgentRuntimeContext(owner.runtimeKind);
      const result = await client.getSessionReview(owner.runtimeId, requested ? { runId: requested.runId } : undefined);
      if (!current) return;
      loaded.value = { owner, review: result };
      const preferredId = requested?.fileId ?? previousId;
      selectedId.value = result.files.find((file) => file.id === preferredId)?.id ?? result.files[0]?.id ?? '';
    } catch {
      if (current) failed.value = true;
    } finally {
      if (current) loading.value = false;
    }
  }, { immediate: true });

  watch([review, selectedFile], async ([currentReview, file], _, onCleanup) => {
    let current = true;
    onCleanup(() => { current = false; });
    lines.value = [];
    diffFailed.value = false;
    const owner = loaded.value?.owner;
    const runId = currentReview?.runId;
    loadingDiff.value = Boolean(owner && runId && file && !file.unavailable);
    if (!owner || !runId || !file || file.unavailable) return;
    try {
      const { client } = getAgentRuntimeContext(owner.runtimeKind);
      const result = await client.getSessionReview(owner.runtimeId, { runId, fileId: file.id });
      if (!current) return;
      if (result.runId !== runId) {
        diffFailed.value = true;
        return;
      }
      lines.value = result.lines ?? [];
    } catch {
      if (current) diffFailed.value = true;
    } finally {
      if (current) loadingDiff.value = false;
    }
  });

  return { failed, diffFailed, lines, loading, loadingDiff, refresh, review, selectedFile, selectedId, session, target };
}
