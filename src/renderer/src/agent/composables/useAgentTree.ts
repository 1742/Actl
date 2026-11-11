import { computed, ref, watch, type InjectionKey } from 'vue';
import type { AgentTreeSnapshot } from '../../../../shared/agent/coordination';
import { useAgentStore } from '../stores/agent';
import { desktopRequest, unwrap } from '../services/desktopTransport';
import { applyAgentTreeSnapshot, applyRuntimeEvent, runtimeResourceKey } from './useAgent';

export const agentTreeKey: InjectionKey<ReturnType<typeof useAgentTree>> = Symbol('agentTree');

export function useAgentTree() {
  const store = useAgentStore();
  const rootId = computed(() => store.session?.rootSessionId ?? store.session?.runtimeId);
  const tree = ref<AgentTreeSnapshot>();
  const error = ref('');

  watch(rootId, (root, _, onCleanup) => {
    tree.value = undefined;
    error.value = '';
    if (!root || !window.actlAgent?.watchTree) return;

    const transport = window.actlAgent;
    const id = crypto.randomUUID();
    let disposed = false;
    let refreshing = false;
    let refreshNeeded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (reason: unknown) => {
      if (!disposed) error.value = String(reason);
    };
    const accept = (snapshot: AgentTreeSnapshot) => {
      if (disposed || snapshot.rootSessionId !== root) return;
      applyAgentTreeSnapshot(snapshot);
      tree.value = snapshot;
      error.value = '';
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
        for (const responseEvent of event.events) applyRuntimeEvent(sessionId, responseEvent);
      }
    });
    onCleanup(() => {
      disposed = true;
      off();
      if (timer) clearTimeout(timer);
      transport.detach(id);
    });
    void transport.watchTree(id, root).then(unwrap).catch(report);
  }, { immediate: true, flush: 'sync' });

  return { rootId, tree, error };
}
