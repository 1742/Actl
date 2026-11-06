import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const createProjectBodySchema = z.object({
  cwd: nonEmptyString,
  name: nonEmptyString.optional(),
}).strict();

export const updateProjectBodySchema = z.object({
  name: nonEmptyString.nullable(),
}).strict();

export const projectParamsSchema = z.object({
  projectId: nonEmptyString,
}).strict();

export const searchProjectFilesQuerySchema = z.object({
  q: z.string().trim().default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const listProjectDirectoryQuerySchema = z.object({
  path: z.string().trim().default("."),
  maxEntries: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;
export type ProjectParams = z.infer<typeof projectParamsSchema>;
export type SearchProjectFilesQuery = z.infer<typeof searchProjectFilesQuerySchema>;
export type ListProjectDirectoryQuery = z.infer<typeof listProjectDirectoryQuerySchema>;
