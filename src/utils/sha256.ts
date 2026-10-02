import { sha256 as sha256Fallback } from '@noble/hashes/sha2.js';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Calculate SHA-256 with Web Crypto when available and a pure JS fallback on HTTP. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return toHex(new Uint8Array(digest));
  }

  return toHex(sha256Fallback(bytes));
}

export function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}
