import { bridge } from '../../services/bridge';
import { tr } from '../../i18n';
import { useRuntimeStore } from '../../stores/runtime';
import { fetchAgentHealth } from './local/service';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INTERVAL_MS = 500;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function ensureAgentRuntimeReady(): Promise<void> {
  const runtime = useRuntimeStore();
  const started = await bridge.ensureAgentStarted();
  runtime.agentUrl = started.agentUrl;
  runtime.agentToken = started.agentToken;

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await fetchAgentHealth(runtime.agentUrl)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(HEALTH_INTERVAL_MS);
  }

  const detail = lastError instanceof Error ? `：${lastError.message}` : '';
  throw new Error(tr('dynamic.localAgentStartupTimeout', { detail }));
}
