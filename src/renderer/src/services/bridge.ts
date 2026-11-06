import type { DesktopSettings } from '../../../shared/agent-ipc';
export type AgentSettings = DesktopSettings;
export const bridge = {
  notifyAgentEvent: (kind: 'completed' | 'permission_requested', title: string, detail: string) => window.actlAgent.notify(kind, title, detail),
  getAgentSettings: () => window.actlAgent.getSettings(),
  saveAgentSettings: (settings: AgentSettings) => window.actlAgent.saveSettings(settings),
  async restartAgent() { await window.actlAgent.restart(); return window.actlAgent.ready(); },
  openAgentDirectory: (kind: 'storage' | 'logs' | 'skills' | 'config') => window.actlAgent.openDirectory(kind),
  ensureAgentStarted: () => window.actlAgent.ready(),
  pickDirectory: () => window.actlAgent.pickDirectory(),
  openSkillsDirectory: () => window.actlAgent.openDirectory('skills'),
};
