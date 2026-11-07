import { z } from "zod";
import type { RuntimeMcpServerConfig } from "../../shared/agent/mcp.js";

export const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
}).strict() satisfies z.ZodType<RuntimeMcpServerConfig>;

export const serverNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

export interface McpConfig { servers: Record<string, RuntimeMcpServerConfig> }
