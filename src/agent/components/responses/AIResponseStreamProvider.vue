<script lang="ts">
import type {
  AIResponseContext,
  AIResponseInputItem,
  AIResponseStreamEvent,
} from '../../types/aiResponse';

export type AIResponseProviderStatus =
  'idle' | 'streaming' | 'completed' | 'failed' | 'incomplete' | 'cancelled';

export interface AIResponseStreamRequest<TPayload = unknown> {
  sessionId: string;
  input: AIResponseInputItem[];
  payload?: TPayload;
}

export type AIResponseRequestHandler<TPayload = unknown> = (
  request: AIResponseStreamRequest<TPayload>,
  onEvent: (event: AIResponseStreamEvent) => void,
  signal: AbortSignal,
) => Promise<void>;
</script>

<script setup lang="ts" generic="TPayload = unknown">
import { onUnmounted, ref, shallowRef, watch } from 'vue';
import { reduceResponseEvent } from '../../composables/useResponseReducer';
import { normalizeResponseContext } from '../../utils/aiResponse';

const props = withDefaults(
  defineProps<{
    request: AIResponseRequestHandler<TPayload>;
    initialContexts?: AIResponseContext[];
  }>(),
  {
    initialContexts: () => [],
  },
);

const emit = defineEmits<{
  'update:contexts': [contexts: AIResponseContext[]];
  event: [event: AIResponseStreamEvent];
  error: [error: Error];
}>();

const contexts = ref<AIResponseContext[]>([...props.initialContexts]);
const status = ref<AIResponseProviderStatus>('idle');
const error = shallowRef<Error>();
const activeResponseId = ref('');
let controller: AbortController | undefined;

watch(
  () => props.initialContexts,
  (value) => {
    if (status.value !== 'streaming') contexts.value = [...value];
  },
);

const publish = () => emit('update:contexts', contexts.value);

const findContext = (responseId?: string) => {
  const id = responseId || activeResponseId.value;
  return contexts.value.find((context) => context.response.id === id);
};

const ingestEvent = (event: AIResponseStreamEvent) => {
  emit('event', event);
  if (event.type === 'response.created') {
    const optimistic = contexts.value.find(
      (context) => context.response.id === activeResponseId.value,
    );
    const reduced = reduceResponseEvent(optimistic, event);
    const index = optimistic ? contexts.value.indexOf(optimistic) : -1;
    if (index >= 0) contexts.value[index] = reduced.context;
    else contexts.value.push(reduced.context);
    activeResponseId.value = reduced.context.response.id;
    status.value = reduced.status;
    publish();
    return reduced;
  }

  const responseId =
    typeof event.response_id === 'string' ? event.response_id : activeResponseId.value;
  const current = findContext(responseId);
  if (!current) return;
  const reduced = reduceResponseEvent(current, event);
  const index = contexts.value.indexOf(current);
  contexts.value[index] = reduced.context;
  status.value = reduced.status;
  if (reduced.message) error.value = new Error(reduced.message);
  publish();
  return reduced;
};

const submit = async (request: AIResponseStreamRequest<TPayload>) => {
  if (controller) throw new Error('A response is already streaming');
  const requestController = new AbortController();
  controller = requestController;
  error.value = undefined;
  status.value = 'streaming';

  const now = new Date().toISOString();
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const optimistic = normalizeResponseContext({
    sessionId: request.sessionId,
    input: request.input,
    response: { id: localId, object: 'response', status: 'in_progress', output: [] },
    createdAt: now,
    updatedAt: now,
  });
  contexts.value.push(optimistic);
  activeResponseId.value = localId;
  publish();

  try {
    await props.request(request, ingestEvent, requestController.signal);
    if (status.value === 'streaming') status.value = 'completed';
  } catch (cause) {
    if (requestController.signal.aborted) return;
    const requestError =
      cause instanceof Error ? cause : new Error(String(cause || 'AI response failed'));
    error.value = requestError;
    status.value = 'failed';
    emit('error', requestError);
    throw requestError;
  } finally {
    if (controller === requestController) controller = undefined;
  }
};

const abort = () => {
  if (!controller || status.value !== 'streaming') return;
  const context = findContext();
  if (context) {
    context.response.status = 'cancelled';
    context.response.output.forEach((item) => {
      if (item.status === 'in_progress' || item.status === 'pending') item.status = 'cancelled';
    });
    context.updatedAt = new Date().toISOString();
    context.completedAt = context.updatedAt;
    publish();
  }
  status.value = 'cancelled';
  controller.abort();
};
const reset = (nextContexts: AIResponseContext[] = []) => {
  abort();
  contexts.value = [...nextContexts];
  activeResponseId.value = '';
  error.value = undefined;
  status.value = 'idle';
  publish();
};

onUnmounted(abort);

defineExpose({ contexts, status, error, activeResponseId, submit, abort, reset, ingestEvent });
</script>

<template>
  <slot
    :contexts="contexts"
    :status="status"
    :error="error"
    :active-response-id="activeResponseId"
    :submit="submit"
    :abort="abort"
    :reset="reset"
    :ingest-event="ingestEvent"
  />
</template>
