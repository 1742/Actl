import type { PromptBlock, PromptSettings } from "../runtime/prompt-compiler.js";

export interface PromptSettingsRepository {
  getPromptSettings(ownerId: string): PromptSettings | undefined;
  savePromptSettings(ownerId: string, expectedRevision: number, blocks: PromptBlock[]): PromptSettings | null;
}
