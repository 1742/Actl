import { z } from "zod";

export const listSkillsQuerySchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  q: z.string().trim().max(256).optional(),
  category: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict().refine(
  ({ sessionId, projectId }) => sessionId === undefined || projectId === undefined,
  {
    message: "sessionId and projectId cannot be used together.",
    path: ["projectId"],
  },
);

export const skillParamsSchema = z.object({
  skillId: z.string().trim().min(1),
}).strict();

export type ListSkillsQuery = z.infer<typeof listSkillsQuerySchema>;
export type SkillParams = z.infer<typeof skillParamsSchema>;
