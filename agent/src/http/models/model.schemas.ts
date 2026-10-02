import { z } from "zod";
import { modelCapabilitiesSchema, modelProtocolSchema, reasoningEffortSchema } from "../../model/catalog-types.js";

export const listModelsQuerySchema = z.object({ sessionId: z.string().trim().min(1).optional() }).strict();
export const modelParamsSchema = z.object({ modelTargetId: z.string().trim().min(1) }).strict();
export const createModelBodySchema = z.object({
  providerModel: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  protocol: modelProtocolSchema,
  capabilities: modelCapabilitiesSchema.optional(),
}).strict();
export const editModelBodySchema = z.object({
  providerModel: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  protocol: modelProtocolSchema.optional(),
  capabilities: modelCapabilitiesSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "At least one field must be provided." });
export const modelPreferenceBodySchema = z.object({
  modelTargetId: z.string().trim().min(1).nullable(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
}).strict();

export type ModelParams = z.infer<typeof modelParamsSchema>;
export type ListModelsQuery = z.infer<typeof listModelsQuerySchema>;
export type CreateModelBody = z.infer<typeof createModelBodySchema>;
export type EditModelBody = z.infer<typeof editModelBodySchema>;
export type ModelPreferenceBody = z.infer<typeof modelPreferenceBodySchema>;
