import { z } from "zod";
import { createModelBodySchema } from "../models/model.schemas.js";

export const providerAccountParamsSchema = z.object({ accountId: z.string().trim().min(1) }).strict();
export const createProviderAccountBodySchema = z.object({
  displayName: z.string().trim().min(1),
  baseURL: z.url(),
  apiKey: z.string().trim().min(1),
}).strict();
export const editProviderAccountBodySchema = z.object({
  displayName: z.string().trim().min(1).optional(), baseURL: z.url().optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "At least one field must be provided." });
export const replaceCredentialBodySchema = z.object({ apiKey: z.string().trim().min(1) }).strict();
export { createModelBodySchema };
