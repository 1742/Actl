import { z } from "zod";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import type { ToolDefinition, ToolPermissionRequirement, ToolProvider, ToolCallContext } from "../registry.js";

const inputSchema = z.object({
  file_id: z.string().trim().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(256 * 1024).optional(),
}).strict();

export class StoredFileToolProvider implements ToolProvider {
  readonly name = "stored-files";

  constructor(private readonly files: StoredFileService) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [{
      name: "read_uploaded_file",
      description: "Read a UTF-8 text file that the user uploaded and attached to the current Session. Use offset and limit to read large files in chunks.",
      inputSchema,
      execution: { concurrency: "parallel" },
    }];
  }

  async getPermissionRequirement(
    _name: string,
    input: unknown,
    _context: ToolCallContext,
  ): Promise<ToolPermissionRequirement> {
    const parsed = inputSchema.parse(input);
    return { capability: "stored_file.read", resource: parsed.file_id, action: "read" };
  }

  async callTool(_name: string, input: unknown, context: ToolCallContext): Promise<unknown> {
    const sessionId = context.sessionId;
    if (!sessionId) throw new Error("read_uploaded_file requires a Session execution context.");
    const parsed = inputSchema.parse(input);
    return this.files.readText(sessionId, parsed.file_id, parsed.offset, parsed.limit);
  }
}
