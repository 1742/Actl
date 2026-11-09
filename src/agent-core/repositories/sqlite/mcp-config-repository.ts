import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../../utils.js";
import type { McpConfigRepository, StoredMcpServer } from "../mcp-config-repository.js";
import { bufferColumn, numberColumn, stringColumn } from "./row.js";

export class SqliteMcpConfigRepository implements McpConfigRepository {
  constructor(private readonly db: DatabaseSync) {}

  listMcpServers(): StoredMcpServer[] {
    const rows = this.db.prepare("SELECT name, ciphertext, nonce, auth_tag, key_version FROM mcp_servers ORDER BY name").all();
    return rows.map((row) => ({
      name: stringColumn(row, "name"),
      credential: {
        ciphertext: bufferColumn(row, "ciphertext"),
        nonce: bufferColumn(row, "nonce"),
        authTag: bufferColumn(row, "auth_tag"),
        keyVersion: numberColumn(row, "key_version"),
      },
    }));
  }

  async upsertMcpServer(server: StoredMcpServer): Promise<void> {
    const secret = server.credential;
    this.db.prepare(`INSERT INTO mcp_servers(name, ciphertext, nonce, auth_tag, key_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
        auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = excluded.updated_at`
    ).run(server.name, secret.ciphertext, secret.nonce, secret.authTag, secret.keyVersion, nowIso());
  }

  async deleteMcpServer(name: string): Promise<void> {
    this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
  }
}
