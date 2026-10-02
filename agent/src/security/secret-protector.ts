import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EncryptedSecret } from "./encrypted-secret.js";

const KEY_BYTES = 32;

/**
 * Protects application secrets using the local master key.
 *
 * It intentionally has no knowledge of the domain that owns a secret or of
 * how encrypted values are persisted.
 */
export class SecretProtector {
  private key: Buffer | undefined;

  constructor(private readonly masterKeyPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.masterKeyPath), { recursive: true });
    try {
      this.key = await readFile(this.masterKeyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(KEY_BYTES);
      await writeFile(this.masterKeyPath, key, { flag: "wx" });
      this.key = key;
    }
    if (this.key.length !== KEY_BYTES) throw new Error("Secret master key is invalid.");
  }

  encrypt(secret: string): EncryptedSecret {
    const key = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: 1 };
  }

  decrypt(envelope: EncryptedSecret): string {
    if (envelope.keyVersion !== 1) throw new Error("Credential key version is unsupported.");
    const decipher = createDecipheriv("aes-256-gcm", this.requireKey(), envelope.nonce);
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error("Secret protector is not initialized.");
    return this.key;
  }
}
