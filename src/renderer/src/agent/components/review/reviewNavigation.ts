import type { InjectionKey, ShallowRef } from 'vue';

export interface ReviewTarget {
  sessionId: string;
  runId: string;
  fileId: string;
}

export const reviewTargetKey: InjectionKey<ShallowRef<ReviewTarget | undefined>> = Symbol('review target');
