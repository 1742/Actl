import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { supportsMime } from "../../model/compatibility.js";
import { RichToolOutput } from "../../runtime/transcript.js";
import { MAX_STORED_FILE_BYTES, type StoredFileService } from "../../stored-files/stored-file-service.js";
import { pathsEqual, resolveToolPath } from "../path-security.js";
import type { ToolCallContext, ToolDefinition, ToolPermissionRequirement, ToolProvider } from "../registry.js";

const inputSchema = z.object({
  path: z.string().trim().min(1).describe("Absolute image path or path relative to the Session cwd."),
}).strict();

export class ReadImageToolProvider implements ToolProvider {
  readonly name = "builtin-images";
  constructor(private readonly files: StoredFileService) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [{ name: "read_image", inputSchema, requiresImageInput: true,
      description: "View a local PNG, JPEG, GIF or WebP image. Returns the image pixels and a persistent snapshot reference. Requires a model supporting the image format; limited to 25 MiB.",
      execution: { concurrency: "parallel" } }];
  }

  async getPermissionRequirement(_name: string, input: unknown, context: ToolCallContext): Promise<ToolPermissionRequirement> {
    const resolved = await resolveToolPath(context.cwd, inputSchema.parse(input).path);
    return { capability: "filesystem.read", resource: resolved, action: "read" };
  }

  async callTool(_name: string, input: unknown, context: ToolCallContext): Promise<RichToolOutput> {
    if (!context.sessionId) throw new Error("read_image requires a Session execution context.");
    const supported = context.modelCapabilities?.input.imageMimeTypes ?? [];
    if (!supported.length) throw new Error("read_image requires a vision model. Switch to a model supporting image input.");
    const resolved = await resolveToolPath(context.cwd, inputSchema.parse(input).path);
    const authorization = context.authorization?.requirement;
    if (authorization?.capability !== "filesystem.read" || !authorization.resource || !pathsEqual(authorization.resource, resolved)) {
      throw new Error("read_image does not have authorization for the resolved path.");
    }
    context.signal?.throwIfAborted();
    const handle = await open(resolved, "r");
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("read_image path must be a regular file.");
      if (info.size > MAX_STORED_FILE_BYTES) throw new Error("Image exceeds the 25 MiB limit.");
      // Bound the actual read as well, in case the file grows after stat().
      const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_STORED_FILE_BYTES + 1));
      let size = 0;
      while (size < buffer.length) {
        context.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_STORED_FILE_BYTES || size > info.size) throw new Error("Image changed size while reading; retry with a stable file.");
      data = buffer.subarray(0, size);
    } finally { await handle.close(); }
    const mediaType = detectImageType(data);
    if (!mediaType) throw new Error("Unsupported image data. Expected PNG, JPEG, GIF or WebP bytes.");
    if (!supportsMime(supported, mediaType)) throw new Error(`Current model does not support ${mediaType}. Switch to a model supporting this image format.`);
    context.signal?.throwIfAborted();
    const file = await this.files.storeImageSnapshot(context.sessionId, path.basename(resolved), mediaType, data);
    return new RichToolOutput({ path: resolved, file_id: file.id, filename: file.filename,
      media_type: file.mediaType, size: file.size, sha256: file.sha256 }, [{ type: "stored_file", fileId: file.id }]);
  }
}

function detectImageType(data: Buffer): string | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (data.length >= 13 && ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) return "image/gif";
  if (data.length >= 16 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}
