import { computed, onScopeDispose, ref, watch, type InjectionKey } from 'vue';
import type { AgentTreeSnapshot } from '../../../../shared/agent/coordination';
import { useAgentStore } from '../stores/agent';
import { desktopRequest, unwrap } from '../services/desktopTransport';
import { applyAgentTreeSnapshot, applyRuntimeEvent, runtimeResourceKey } from './useAgent';

export const agentTreeKey: InjectionKey<ReturnType<typeof useAgentTree>> = Symbol('agentTree');

export function useAgentTree() {
  const store = useAgentStore();
  const tree = computed(() => store.currentTree);
  const rootId = computed(() => tree.value?.members[tree.value.rootId]?.session.runtimeId);
  const requestedMember = ref<{ sessionId: string }>();
  const errors = ref<Record<string, string>>({});
  const error = computed(() => errors.value[rootId.value ?? ''] ?? '');
  const subscriptions = new Map<string, () => void>();

  watch(rootId, () => { requestedMember.value = undefined; }, { flush: 'sync' });
  watch(() => {
    const roots = new Set<string>();
    if (rootId.value) roots.add(rootId.value);
    for (const candidate of Object.values(store.trees)) {
      const root = candidate.members[candidate.rootId]?.session.runtimeId;
      if (root && (Object.keys(candidate.members).some(store.sessionIsActive)
        || candidate.tasks.some(({ status }) => status === 'assigned' || status === 'running'))) roots.add(root);
    }
    return roots;
  }, (roots) => {
    for (const [root, unsubscribe] of subscriptions) {
      if (roots.has(root)) continue;
      unsubscribe();
      subscriptions.delete(root);
      delete errors.value[root];
    }
    for (const root of roots) {
      if (!subscriptions.has(root) && window.actlAgent) subscriptions.set(root, subscribe(root));
    }
  }, { immediate: true });

  onScopeDispose(() => {
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });

  function subscribe(root: string) {
    const transport = window.actlAgent;
    const id = crypto.randomUUID();
    let disposed = false;
    let refreshing = false;
    let refreshNeeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (reason: unknown) => {
      if (!disposed) errors.value[root] = String(reason);
    };
    const accept = (snapshot: AgentTreeSnapshot) => {
      if (disposed || snapshot.rootSessionId !== root) return;
      applyAgentTreeSnapshot(snapshot);
      delete errors.value[root];
    };
    const refresh = () => {
      if (disposed || refreshing || timer) return;
      timer = setTimeout(async () => {
        timer = undefined;
        refreshing = true;
        refreshNeeded = false;
        try {
          accept(await desktopRequest<AgentTreeSnapshot>({ operation: 'agents.tree', params: { sessionId: root } }));
        } catch (reason) {
          report(reason);
        } finally {
          refreshing = false;
          if (refreshNeeded) refresh();
        }
      }, 50);
    };
    const off = transport.onTreeEvents(({ subscriptionId, event }) => {
      if (disposed || subscriptionId !== id) return;
      if (event.type === 'snapshot') accept(event.snapshot);
      else if (event.type === 'changed') {
        refreshNeeded = true;
        refresh();
      } else {
        const sessionId = runtimeResourceKey('local', event.sessionId);
        if (!store.sessionById(sessionId)) {
          refreshNeeded = true;
          refresh();
          return;
        }
        for (const responseEvent of event.events) applyRuntimeEvent(sessionId, responseEvent);
      }
    });
    void transport.watchTree(id, root).then(unwrap).catch(report);
    return () => {
      disposed = true;
      off();
      if (timer) clearTimeout(timer);
      transport.detach(id);
    };
  }

  return { rootId, tree, error, requestedMember };
}
