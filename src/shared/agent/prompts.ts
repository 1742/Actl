export interface RuntimePromptBlock {
  id: string;
  title: string;
  text: string;
  enabled: boolean;
}

export interface RuntimePromptSettings {
  revision: number;
  blocks: RuntimePromptBlock[];
  updatedAt: string | null;
}
