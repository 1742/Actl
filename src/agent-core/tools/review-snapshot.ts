import { isPathInside } from "./path-security.js";
import type { ToolCallContext } from "./registry.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Whether record file change. Return true when context provide recordFileChange method and file inside root. */
export function tracksFile(context: ToolCallContext, filePath: string): boolean {
  const roots = context.fileEditRoots ?? (context.cwd ? [context.cwd] : []);
  return Boolean(context.recordFileChange && roots.some((root) => isPathInside(root, filePath)));
}

export function reviewText(text: string): string | undefined {
  return Buffer.byteLength(text) <= MAX_SNAPSHOT_BYTES && !/[\x00-\x08\x0e-\x1f\ufffd]/.test(text)
    ? text : undefined;
}
