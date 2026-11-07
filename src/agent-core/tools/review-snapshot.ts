import { open } from "node:fs/promises";
import { isPathInside } from "./path-security.js";
import type { ToolCallContext } from "./registry.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;

export function tracksFile(context: ToolCallContext, filePath: string): boolean {
  return Boolean(context.recordFileChange && context.cwd && isPathInside(context.cwd, filePath));
}

export function reviewText(text: string): string | undefined {
  return Buffer.byteLength(text) <= MAX_SNAPSHOT_BYTES && !/[\x00-\x08\x0e-\x1f\ufffd]/.test(text)
    ? text : undefined;
}

export async function readReviewSnapshot(filePath: string): Promise<{ created: boolean; before: string | undefined }> {
  try {
    const handle = await open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return { created: false, before: undefined };
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const before = offset === stat.size ? reviewText(buffer.subarray(0, offset).toString("utf8")) : undefined;
      return { created: false, before };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { created: (error as NodeJS.ErrnoException).code === "ENOENT", before: undefined };
  }
}
