import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const updateProjectBodySchema = z.object({
  name: nonEmptyString.optional(),
  workspacePaths: z.array(nonEmptyString).min(1),
  primaryWorkspacePath: nonEmptyString,
}).strict();

export const createProjectBodySchema = z.union([
  updateProjectBodySchema,
  z.object({ cwd: nonEmptyString, name: nonEmptyString.optional() }).strict().transform(({ cwd, name }) => ({
    name, workspacePaths: [cwd], primaryWorkspacePath: cwd,
  })),
]);

export const projectParamsSchema = z.object({
  projectId: nonEmptyString,
}).strict();

export const workspaceParamsSchema = projectParamsSchema.extend({
  workspaceId: nonEmptyString.optional(),
});

export const searchProjectFilesQuerySchema = z.object({
  q: z.string().trim().default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export const listProjectDirectoryQuerySchema = z.object({
  path: z.string().trim().default("."),
  maxEntries: z.coerce.number().int().min(1).max(500).default(200),
}).strict();

export const previewProjectFileQuerySchema = z.object({
  path: z.string().min(1).max(4096),
}).strict();

export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectBodySchema>;
export type ProjectParams = z.infer<typeof projectParamsSchema>;
export type SearchProjectFilesQuery = z.infer<typeof searchProjectFilesQuerySchema>;
export type ListProjectDirectoryQuery = z.infer<typeof listProjectDirectoryQuerySchema>;
