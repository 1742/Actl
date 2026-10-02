import { z } from "zod";

export const modelProtocolSchema = z.enum(["responses", "chat_completions", "anthropic_messages"]);
export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const modelCapabilitiesSchema = z.object({
  input: z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { directFileMimeTypes: _legacyDirectFileMimeTypes, ...input } = value as Record<string, unknown>;
    return input;
  }, z.object({
    text: z.literal(true),
    imageMimeTypes: z.array(z.string().trim().min(1)),
    audioMimeTypes: z.array(z.string().trim().min(1)),
  }).strict()),
  toolCalling: z.boolean(),
  parallelToolCalls: z.boolean(),
  nativeWebSearch: z.boolean().default(false),
  reasoningEfforts: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();

export type ModelProtocolConfig = z.infer<typeof modelProtocolSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const TEXT_TOOL_CAPABILITIES: ModelCapabilities = {
  input: { text: true, imageMimeTypes: [], audioMimeTypes: [] },
  toolCalling: true,
  parallelToolCalls: true,
  nativeWebSearch: false,
  reasoningEfforts: [],
};

export interface ProviderAccountRecord {
  id: string;
  ownerId: string;
  displayName: string;
  enabled: boolean;
  currentVersion: number;
  baseURL: string;
  credentialVersion: number | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelTargetRecord {
  id: string;
  ownerId: string;
  accountId: string;
  providerModel: string;
  displayName: string;
  protocol: ModelProtocolConfig;
  capabilities: ModelCapabilities;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelExecutionSnapshot {
  targetId: string;
  displayName: string;
  providerModel: string;
  reasoningEffort?: ReasoningEffort | undefined;

  // user model
  accountId: string;
  accountVersion: number;
  credentialVersion: number;
  baseURL: string;
  protocol: ModelProtocolConfig;
  capabilities: ModelCapabilities;
}

export const modelExecutionSnapshotSchema: z.ZodType<ModelExecutionSnapshot> = z.object({
  targetId: z.string().min(1), displayName: z.string().min(1),
  providerModel: z.string().min(1), reasoningEffort: reasoningEffortSchema.optional(),
  accountId: z.string().min(1),
  accountVersion: z.number().int().positive(), credentialVersion: z.number().int().positive(),
  baseURL: z.url(), protocol: modelProtocolSchema, capabilities: modelCapabilitiesSchema,
}).strict();

export interface ModelTargetDto {
  id: string;
  providerAccountId: string;
  providerModel: string;
  protocol: ModelProtocolConfig;
  displayName: string;
  enabled: boolean;
  capabilities: ModelCapabilities;
  compatible?: boolean;
  incompatibilityReasons?: string[];
}
