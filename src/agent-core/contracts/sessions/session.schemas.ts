import { z } from "zod";
import { reasoningEffortSchema } from "../../model/catalog-types.js";
import { permissionModeSchema } from "../../permissions/engine.js";
const nonEmptyString = z.string().trim().min(1);
const sessionParamsShape = { sessionId: nonEmptyString };

export const createSessionBodySchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({ projectId: nonEmptyString.optional(), title: nonEmptyString.optional() }).strict(),
);

export const updateSessionBodySchema = z.object({ title: nonEmptyString.nullable() }).strict();
export const bindSessionBodySchema = z.object({ projectId: nonEmptyString }).strict();
const permissionDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ permission_id: nonEmptyString, decision: z.literal("approve") }).strict(),
  z.object({ permission_id: nonEmptyString, decision: z.literal("deny"), reason: nonEmptyString.optional() }).strict(),
]);
export const resolvePermissionsBodySchema = z.object({
  batchId: nonEmptyString,
  decisions: z.array(permissionDecisionSchema).min(1),
}).strict();

const inputContentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input_text"),
    text: nonEmptyString,
  }).strict(),
  z.object({
    type: z.literal("input_workspace_file"),
    path: nonEmptyString,
  }).strict(),
  z.object({
    type: z.literal("input_file"),
    file_id: nonEmptyString,
  }).strict(),
  z.object({
    type: z.literal("input_skill"),
    id: nonEmptyString,
    name: nonEmptyString.optional(),
  }).strict().transform(({ type, id, name }) => (
    name ? { type, id, name } : { type, id }
  )),
  z.object({
    type: z.literal("input_mcp_server"),
    name: nonEmptyString,
  }).strict(),
]);

const inputMessageSchema = z.object({
  type: z.literal("message"),
  role: z.literal("user"),
  content: z.array(inputContentSchema).min(1),
}).strict();

export const createResponseBodySchema = z.object({
  input: z.array(inputMessageSchema).min(1),
  stream: z.boolean().optional(),
  model: nonEmptyString,
  reasoningEffort: reasoningEffortSchema.optional(),
  permissionMode: permissionModeSchema.optional().default("ask"),
}).strict();

export const compactSessionBodySchema = z.object({
  model: nonEmptyString,
  reasoningEffort: reasoningEffortSchema.optional(),
}).strict();

export const sessionParamsSchema = z.object(sessionParamsShape).strict();
export const responseParamsSchema = z.object({ ...sessionParamsShape, responseId: nonEmptyString }).strict();

export const listSessionsQuerySchema = z.object({
  scope: z.literal("standalone").optional(),
  projectId: nonEmptyString.optional(),
}).strict().refine((value) => !(value.scope && value.projectId), {
  path: ["scope"],
  message: "scope and projectId cannot be combined.",
});

export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
export type UpdateSessionBody = z.infer<typeof updateSessionBodySchema>;
export type BindSessionBody = z.infer<typeof bindSessionBodySchema>;
export type CreateResponseBody = z.infer<typeof createResponseBodySchema>;
export type CompactSessionBody = z.infer<typeof compactSessionBodySchema>;
export type ResolvePermissionsBody = z.infer<typeof resolvePermissionsBodySchema>;
export type SessionParams = z.infer<typeof sessionParamsSchema>;
export type ResponseParams = z.infer<typeof responseParamsSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
