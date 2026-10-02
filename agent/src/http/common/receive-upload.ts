import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import type { Request } from "express";

export interface ReceivedUpload {
  temporaryPath: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export interface ReceiveUploadOptions {
  /** Field name that must carry the file. */
  fieldName?: string;
  maxBytes?: number;
}

export class UploadReceivingError extends Error {
  constructor(
    readonly code: "invalid_upload" | "file_too_large",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Receives a single multipart file into stagingRoot. Mirrors the stored-files
 * upload pipeline but is generic so Skill import can enforce its own limits.
 */
export async function receiveSingleUpload(
  request: Request,
  stagingRoot: string,
  options: ReceiveUploadOptions = {},
): Promise<ReceivedUpload> {
  const fieldName = options.fieldName ?? "file";
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        // Browsers send a UTF-8 filename parameter for FormData uploads. Busboy
        // otherwise assumes latin1 for parameters without an explicit charset.
        defParamCharset: "utf8",
        limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2 },
      });
    } catch {
      reject(new UploadReceivingError("invalid_upload", "Request must contain multipart/form-data."));
      return;
    }
    let filePromise: Promise<ReceivedUpload> | undefined;
    let limitExceeded = false;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    parser.on("file", (fieldname, stream, info) => {
      if (fieldname !== fieldName || filePromise) {
        stream.resume();
        fail(new UploadReceivingError(
          "invalid_upload",
          `Upload must contain exactly one file field named ${fieldName}.`,
        ));
        return;
      }
      const temporaryPath = path.join(stagingRoot, `${process.pid}-${crypto.randomUUID()}.upload`);
      const hash = crypto.createHash("sha256");
      let size = 0;
      stream.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      stream.on("limit", () => {
        limitExceeded = true;
      });
      filePromise = pipeline(stream, createWriteStream(temporaryPath, { flags: "wx" })).then(async () => {
        if (limitExceeded || stream.truncated) {
          await rm(temporaryPath, { force: true });
          throw new UploadReceivingError("file_too_large", `File exceeds the ${maxBytes} byte limit.`);
        }
        return {
          temporaryPath,
          filename: safeFilename(info.filename),
          mediaType: normalizeMediaType(info.mimeType),
          size,
          sha256: hash.digest("hex"),
        };
      });
    });
    parser.on("filesLimit", () => fail(new UploadReceivingError("invalid_upload", "Only one file may be uploaded at a time.")));
    parser.on("fieldsLimit", () => fail(new UploadReceivingError("invalid_upload", "Upload form fields are not supported.")));
    parser.on("partsLimit", () => fail(new UploadReceivingError("invalid_upload", "Upload must contain only one file part.")));
    parser.on("error", fail);
    parser.on("close", () => {
      if (settled) return;
      if (!filePromise) return fail(new UploadReceivingError("invalid_upload", "Upload did not contain a file."));
      void filePromise.then((value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      }, fail);
    });
    request.pipe(parser);
  });
}

function safeFilename(filename: string): string {
  const value = path.basename(filename.replaceAll("\\", "/")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").trim();
  return (value || "upload").slice(0, 255);
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase() || "application/octet-stream";
}
