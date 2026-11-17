import { computed, shallowRef, watch } from 'vue';
import type { ReviewFile } from '../../../../../shared/agent/review';
import { getAgentRuntimeContext } from '../../services/runtimeClient';
import { useAgentStore } from '../../stores/agent';
import type { ReviewRun, ReviewTarget } from './reviewNavigation';

interface FileChange {
  file: ReviewFile;
  target: ReviewTarget;
}

export function useFileChanges(runs: () => readonly ReviewRun[]) {
  const store = useAgentStore();
  const changesByRun = shallowRef(new Map<string, FileChange[]>());

  watch(() => runs().map(({ runId }) => runId).join('\n'), async (_, __, onCleanup) => {
    let current = true;
    onCleanup(() => { current = false; });
    const loaded = new Map(changesByRun.value);
    await Promise.all(runs().map(async (run) => {
      if (loaded.has(run.runId)) return;
      const session = store.sessionById(run.sessionId);
      if (!session || run.runId.startsWith('local-')) return;
      try {
        const { client } = getAgentRuntimeContext(session.runtimeKind);
        const review = await client.getSessionReview(session.runtimeId, { runId: run.runId });
        if (review.runId !== run.runId) return;
        loaded.set(run.runId, review.files.map((file) => ({ file, target: { ...run, fileId: file.id } })));
      } catch {
        // Each run's file summary can load independently of the others.
      }
    }));
    if (current) changesByRun.value = loaded;
  }, { immediate: true });

  return computed(() => {
    const grouped = new Map<string, FileChange[]>();
    for (const { runId } of runs()) {
      for (const change of changesByRun.value.get(runId) ?? []) {
        const key = change.file.path.toLowerCase();
        const entries = grouped.get(key);
        if (entries) entries.push(change);
        else grouped.set(key, [change]);
      }
    }
    return Array.from(grouped, ([key, changes]) => ({
      key,
      path: changes[0]!.file.path,
      changes,
      additions: changes.reduce((sum, { file }) => sum + file.additions, 0),
      deletions: changes.reduce((sum, { file }) => sum + file.deletions, 0),
      available: changes.some(({ file }) => !file.unavailable),
    }));
  });
}
