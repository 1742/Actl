import { z } from "zod";
import type { EncryptedSecret } from "../security/encrypted-secret.js";

export const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
}).strict();

export const serverNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);

export type McpServerConfig = z.infer<typeof serverSchema>;
export interface McpConfig { servers: Record<string, McpServerConfig> }

export interface StoredMcpServer {
  name: string;
  credential: EncryptedSecret;
}

export interface McpConfigRepository {
  listMcpServers(): StoredMcpServer[];
  upsertMcpServer(server: StoredMcpServer): Promise<void>;
  deleteMcpServer(name: string): Promise<void>;
}
