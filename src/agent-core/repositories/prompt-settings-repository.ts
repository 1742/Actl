import type { RuntimePromptBlock, RuntimePromptSettings } from "../../shared/agent/prompts.js";

export interface PromptSettingsRepository {
  getPromptSettings(ownerId: string): RuntimePromptSettings | undefined;
  savePromptSettings(ownerId: string, expectedRevision: number, blocks: RuntimePromptBlock[]): RuntimePromptSettings | null;
}
