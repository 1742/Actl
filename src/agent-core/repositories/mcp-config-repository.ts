import type { EncryptedSecret } from "../security/encrypted-secret.js";

export interface StoredMcpServer {
  name: string;
  credential: EncryptedSecret;
}

export interface McpConfigRepository {
  listMcpServers(): StoredMcpServer[];
  upsertMcpServer(server: StoredMcpServer): Promise<void>;
  deleteMcpServer(name: string): Promise<void>;
}
