import { computed, type InjectionKey, type ShallowRef } from 'vue';
import { useAgentStore } from '../../stores/agent';

export interface ReviewRun {
  sessionId: string;
  runId: string;
}

export interface ReviewTarget extends ReviewRun {
  fileId: string;
}

export const reviewTargetKey: InjectionKey<ShallowRef<ReviewTarget | undefined>> = Symbol('review target');

export function useTreeReviewTarget(request: Readonly<ShallowRef<ReviewTarget | undefined>> | undefined) {
  const store = useAgentStore();
  return computed(() => {
    const target = request?.value;
    return target && store.currentTree?.members[target.sessionId] ? target : undefined;
  });
}
