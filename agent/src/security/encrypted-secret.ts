/** An authenticated ciphertext that can be persisted by any domain. */
export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}
