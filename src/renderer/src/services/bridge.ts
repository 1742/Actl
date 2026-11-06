import type { RuntimeConfig } from '../types/common';
import type { DesktopSettings } from '../../../shared/agent-ipc';
export type AgentSettings = DesktopSettings;
const runtimeConfig = (): RuntimeConfig => ({ agentUrl: 'electron:ipc', agentToken: '' });
export const bridge = {
  notifyAgentEvent: (kind: 'completed' | 'permission_requested', title: string, detail: string) => window.actlAgent.notify(kind, title, detail),
  getAgentSettings: () => window.actlAgent.getSettings(),
  saveAgentSettings: (settings: AgentSettings) => window.actlAgent.saveSettings(settings),
  async restartAgent() { await window.actlAgent.restart(); await window.actlAgent.ready(); return runtimeConfig(); },
  openAgentDirectory: (kind: 'storage' | 'logs' | 'skills' | 'config') => window.actlAgent.openDirectory(kind),
  async getRuntimeConfig() { await window.actlAgent.ready(); return runtimeConfig(); },
  async ensureAgentStarted() { await window.actlAgent.ready(); return runtimeConfig(); },
  pickDirectory: () => window.actlAgent.pickDirectory(),
  openSkillsDirectory: () => window.actlAgent.openDirectory('skills'),
};
