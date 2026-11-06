import { bridge } from '../../services/bridge';
import { useRuntimeStore } from '../../stores/runtime';
export async function ensureAgentRuntimeReady(): Promise<void> {
  useRuntimeStore().apply(await bridge.ensureAgentStarted());
}
