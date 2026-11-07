export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export const modelProtocols = ["responses", "chat_completions", "anthropic_messages"] as const;
export type RuntimeModelProtocol = (typeof modelProtocols)[number];

export interface RuntimeModelCapabilities {
  input: { text: true; imageMimeTypes: string[]; audioMimeTypes: string[] };
  toolCalling: boolean;
  parallelToolCalls: boolean;
  nativeWebSearch: boolean;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
}

export interface RuntimeModel {
  id: string;
  providerAccountId: string;
  providerModel: string;
  protocol: RuntimeModelProtocol;
  displayName: string;
  enabled: boolean;
  compatible?: boolean;
  incompatibilityReasons?: string[];
  capabilities: RuntimeModelCapabilities;
}

export interface RuntimeModelConfig {
  providerModel: string;
  displayName: string;
  protocol: RuntimeModelProtocol;
  capabilities: RuntimeModelCapabilities;
}

export interface RuntimeModelCatalog {
  data: RuntimeModel[];
  selectedModelTargetId?: string;
  selectedReasoningEffort?: ReasoningEffort;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface RuntimeProviderAccount {
  id: string;
  displayName: string;
  baseURL: string;
  enabled: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRuntimeProviderAccount { displayName: string; baseURL: string; apiKey: string; }
