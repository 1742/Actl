import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const storedFileParamsSchema = z.object({
  sessionId: nonEmptyString,
  fileId: nonEmptyString,
}).strict();

export type StoredFileParams = z.infer<typeof storedFileParamsSchema>;
