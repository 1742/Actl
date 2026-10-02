import { invoke } from '@tauri-apps/api/core';
import type { RuntimeConfig } from '../types/common';

export interface AgentSettings {
  port: number;
  storageDirectory: string;
}

class BridgeService {
  notifyAgentEvent(
    kind: 'completed' | 'permission_requested',
    sessionTitle: string,
    detail: string,
  ): Promise<void> {
    return invoke<void>('notify_agent_event', { kind, sessionTitle, detail });
  }

  getAgentSettings(): Promise<AgentSettings> {
    return invoke<AgentSettings>('get_agent_settings');
  }

  saveAgentSettings(settings: AgentSettings): Promise<void> {
    return invoke<void>('save_agent_settings', { settings });
  }

  restartAgent(): Promise<RuntimeConfig> {
    return invoke<RuntimeConfig>('restart_agent');
  }

  openAgentDirectory(kind: 'storage' | 'logs' | 'skills' | 'config'): Promise<void> {
    return invoke<void>('open_agent_directory', { kind });
  }

  getRuntimeConfig(): Promise<RuntimeConfig> {
    return invoke<RuntimeConfig>('get_runtime_config');
  }

  ensureAgentStarted(): Promise<RuntimeConfig> {
    return this.getRuntimeConfig();
  }

  pickDirectory(): Promise<string | null> {
    return invoke<string | null>('pick_directory');
  }

  openSkillsDirectory(): Promise<void> {
    return invoke<void>('open_skills_directory');
  }
}

export const bridge = new BridgeService();
