import Busboy from "busboy";
import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";
import type { TranscriptItem } from "../model/types.js";
import type { ModelCapabilities } from "../model/catalog-types.js";
import { supportsMime } from "../model/compatibility.js";
import type { StoredFileRecord, StoredFileRepository } from "../repositories/workspace-repository.js";
import { createRandomId, nowIso } from "../utils.js";

export const MAX_STORED_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_RESPONSE = 10;
export const MAX_RESPONSE_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_READ_CHARS = 256 * 1024;
const DRAFT_RETENTION_MS = 24 * 60 * 60 * 1_000;

const MODEL_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "html", "css",
  "js", "jsx", "ts", "tsx", "dart", "py", "java", "kt", "cs", "c", "cpp", "h", "hpp", "go", "rs",
  "rb", "php", "sh", "ps1", "bat", "sql", "toml", "ini", "env",
]);

export type StoredFileServiceErrorCode =
  | "invalid_upload"
  | "file_too_large"
  | "stored_file_not_found"
  | "stored_file_session_mismatch"
  | "too_many_files"
  | "files_total_too_large"
  | "unsupported_file_type"
  | "unsupported_text_encoding";

export class StoredFileServiceError extends Error {
  constructor(readonly code: StoredFileServiceErrorCode, message: string) {
    super(message);
  }
}

export interface StoredFileInputMetadata {
  file_id: string;
  filename: string;
  media_type: string;
  size: number;
}

export class StoredFileService {
  private readonly filesRoot: string;
  private readonly blobsRoot: string;
  private readonly stagingRoot: string;
  private storageMutationQueue: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string, private readonly repository: StoredFileRepository) {
    this.filesRoot = path.join(dataDirectory, "files");
    this.blobsRoot = path.join(this.filesRoot, "blobs");
    this.stagingRoot = path.join(this.filesRoot, "staging");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.blobsRoot, { recursive: true }),
      mkdir(this.stagingRoot, { recursive: true }),
    ]);
    await this.repository.deleteExpiredUnboundFiles(new Date(Date.now() - DRAFT_RETENTION_MS).toISOString());
    await this.cleanupOrphans();
    await this.cleanupStaging();
  }

  async upload(sessionId: string, request: Request): Promise<StoredFileRecord> {
    const upload = await receiveSingleFile(request, this.stagingRoot);
    return this.enqueueStorageMutation(async () => {
      const sha256 = upload.sha256;
      const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
      const target = this.resolveStorageKey(storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      if (await exists(target)) await rm(upload.temporaryPath, { force: true });
      else await rename(upload.temporaryPath, target);

      const record: StoredFileRecord = {
        id: createRandomId("file"),
        sessionId,
        filename: upload.filename,
        mediaType: upload.mediaType,
        size: upload.size,
        sha256,
        storageKey,
        createdAt: nowIso(),
      };
      try {
        await this.repository.createStoredFile(record);
      } catch (error) {
        await this.cleanupOrphansNow();
        throw error;
      }
      return record;
    });
  }

  get(fileId: string): StoredFileRecord | undefined {
    return this.repository.getStoredFile(fileId);
  }

  getForSession(sessionId: string, fileId: string): StoredFileRecord {
    const file = this.repository.getStoredFile(fileId);
    if (!file) throw new StoredFileServiceError("stored_file_not_found", "Stored file not found.");
    if (file.sessionId !== sessionId) {
      throw new StoredFileServiceError("stored_file_session_mismatch", "Stored file does not belong to this Session.");
    }
    return file;
  }

  describeForSession(sessionId: string, fileId: string): StoredFileInputMetadata | undefined {
    const file = this.repository.getStoredFile(fileId);
    if (!file || file.sessionId !== sessionId) return undefined;
    return toInputMetadata(file);
  }

  list(sessionId: string): StoredFileRecord[] {
    return this.repository.listStoredFiles(sessionId);
  }

  validateResponseFiles(sessionId: string, fileIds: readonly string[]): void {
    if (fileIds.length > MAX_FILES_PER_RESPONSE) {
      throw new StoredFileServiceError("too_many_files", `At most ${MAX_FILES_PER_RESPONSE} files may be attached to one Response.`);
    }
    if (new Set(fileIds).size !== fileIds.length) {
      throw new StoredFileServiceError("invalid_upload", "A file may only be attached once to a Response.");
    }
    let total = 0;
    for (const fileId of fileIds) total += this.getForSession(sessionId, fileId).size;
    if (total > MAX_RESPONSE_FILE_BYTES) {
      throw new StoredFileServiceError("files_total_too_large", "Attached files exceed the 100 MiB total limit.");
    }
  }

  /** Persist the bytes observed by a tool, rather than replaying a mutable path. */
  async storeImageSnapshot(sessionId: string, filename: string, mediaType: string, data: Buffer): Promise<StoredFileRecord> {
    if (!MODEL_IMAGE_TYPES.has(mediaType)) throw new StoredFileServiceError("unsupported_file_type", "Unsupported image format.");
    if (data.length > MAX_STORED_FILE_BYTES) throw new StoredFileServiceError("file_too_large", "Image exceeds the 25 MiB limit.");
    return this.enqueueStorageMutation(async () => {
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
      const target = this.resolveStorageKey(storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      if (!(await exists(target))) {
        const temporaryPath = path.join(this.stagingRoot, `${crypto.randomUUID()}.image`);
        try {
          await writeFile(temporaryPath, data, { flag: "wx" });
          await rename(temporaryPath, target);
        } finally {
          await rm(temporaryPath, { force: true });
        }
      }
      const record: StoredFileRecord = {
        id: createRandomId("file"), sessionId, filename: safeFilename(filename), mediaType,
        size: data.length, sha256, storageKey, createdAt: nowIso(),
      };
      try { await this.repository.createStoredFile(record); }
      catch (error) { await this.cleanupOrphansNow(); throw error; }
      return record;
    });
  }

  async materializeTranscript(sessionId: string, transcript: TranscriptItem[], capabilities?: ModelCapabilities): Promise<TranscriptItem[]> {
    return Promise.all(transcript.map(async (item): Promise<TranscriptItem> => {
      if (item.type !== "message" && item.type !== "tool_result") return structuredClone(item);
      const content = await Promise.all(item.content.map(async (part) => {
        if (part.type === "image" && capabilities) {
          const mediaType = part.source.type === "data" ? part.source.mediaType : "image/*";
          if (!supportsMime(capabilities.input.imageMimeTypes, mediaType)) {
            return imagePlaceholder(mediaType);
          }
        }
        if (part.type !== "stored_file") return structuredClone(part);
        const file = this.getForSession(sessionId, part.fileId);
        if (MODEL_IMAGE_TYPES.has(file.mediaType)) {
          if (capabilities && !supportsMime(capabilities.input.imageMimeTypes, file.mediaType)) {
            return imagePlaceholder(`${file.filename}; file_id=${file.id}; media_type=${file.mediaType}`);
          }
          const data = await readFile(this.resolveStorageKey(file.storageKey));
          return { type: "image" as const, source: { type: "data" as const, data: data.toString("base64"), mediaType: file.mediaType } };
        }
        const readability = isTextFile(file) ? "Use read_uploaded_file with this file_id to inspect it." : "This file type is stored but is not readable by the model.";
        return {
          type: "text" as const,
          text: `[Attached file: ${file.filename}; file_id=${file.id}; media_type=${file.mediaType}; size=${file.size} bytes. ${readability}]`,
        };
      }));
      return { ...structuredClone(item), content };
    }));
  }

  async readText(sessionId: string, fileId: string, offset = 0, limit = 64 * 1024): Promise<{
    file_id: string; filename: string; text: string; offset: number; next_offset: number; eof: boolean;
  }> {
    const file = this.getForSession(sessionId, fileId);
    if (!isTextFile(file)) {
      throw new StoredFileServiceError("unsupported_file_type", "This stored file type is not readable.");
    }
    const bytes = await readFile(this.resolveStorageKey(file.storageKey));
    if (bytes.includes(0)) {
      throw new StoredFileServiceError("unsupported_text_encoding", "Stored file appears to contain binary data.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new StoredFileServiceError("unsupported_text_encoding", "Stored text files must use UTF-8 encoding.");
    }
    const safeOffset = Math.min(offset, text.length);
    const safeLimit = Math.min(limit, MAX_TEXT_READ_CHARS);
    const chunk = text.slice(safeOffset, safeOffset + safeLimit);
    const nextOffset = safeOffset + chunk.length;
    return { file_id: fileId, filename: file.filename, text: chunk, offset: safeOffset, next_offset: nextOffset, eof: nextOffset >= text.length };
  }

  contentPath(sessionId: string, fileId: string): { file: StoredFileRecord; path: string } {
    const file = this.getForSession(sessionId, fileId);
    return { file, path: this.resolveStorageKey(file.storageKey) };
  }

  async cleanupOrphans(): Promise<void> {
    await this.enqueueStorageMutation(() => this.cleanupOrphansNow());
  }

  private async cleanupOrphansNow(): Promise<void> {
    const referenced = new Set(this.repository.listReferencedStorageKeys());
    for (const filePath of await listFiles(this.blobsRoot)) {
      const key = path.relative(this.blobsRoot, filePath).split(path.sep).join("/");
      if (!referenced.has(key)) await rm(filePath, { force: true });
    }
  }

  private async cleanupStaging(): Promise<void> {
    const cutoff = Date.now() - DRAFT_RETENTION_MS;
    for (const filePath of await listFiles(this.stagingRoot)) {
      if ((await stat(filePath)).mtimeMs < cutoff) await rm(filePath, { force: true });
    }
  }

  private resolveStorageKey(storageKey: string): string {
    const target = path.resolve(this.blobsRoot, ...storageKey.split("/"));
    const relative = path.relative(this.blobsRoot, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Invalid stored file key.");
    }
    return target;
  }

  private enqueueStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageMutationQueue.catch(() => undefined).then(operation);
    this.storageMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function imagePlaceholder(description: string): { type: "text"; text: string } {
  return { type: "text", text: `[Historical image: ${description}. The current model does not support this image input; image pixels were not provided in this request. Earlier descriptions were produced by a previous model and have not been visually verified by the current model.]` };
}

async function receiveSingleFile(request: Request, stagingRoot: string): Promise<{
  temporaryPath: string; filename: string; mediaType: string; size: number; sha256: string;
}> {
  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        // Keep browser FormData filenames in UTF-8 instead of Busboy's latin1 default.
        defParamCharset: "utf8",
        limits: { fileSize: MAX_STORED_FILE_BYTES, files: 1, fields: 0, parts: 2 },
      });
    } catch {
      reject(new StoredFileServiceError("invalid_upload", "Request must contain multipart/form-data."));
      return;
    }
    let filePromise: Promise<{ temporaryPath: string; filename: string; mediaType: string; size: number; sha256: string }> | undefined;
    let limitExceeded = false;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    parser.on("file", (fieldname, stream, info) => {
      if (fieldname !== "file" || filePromise) {
        stream.resume();
        fail(new StoredFileServiceError("invalid_upload", "Upload must contain exactly one file field named file."));
        return;
      }
      const temporaryPath = path.join(stagingRoot, `${process.pid}-${crypto.randomUUID()}.upload`);
      const hash = crypto.createHash("sha256");
      let size = 0;
      stream.on("data", (chunk: Buffer) => { hash.update(chunk); size += chunk.length; });
      stream.on("limit", () => { limitExceeded = true; });
      filePromise = pipeline(stream, createWriteStream(temporaryPath, { flags: "wx" })).then(async () => {
        if (limitExceeded || stream.truncated) {
          await rm(temporaryPath, { force: true });
          throw new StoredFileServiceError("file_too_large", "File exceeds the 25 MiB limit.");
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
    parser.on("filesLimit", () => fail(new StoredFileServiceError("invalid_upload", "Only one file may be uploaded at a time.")));
    parser.on("fieldsLimit", () => fail(new StoredFileServiceError("invalid_upload", "Upload form fields are not supported.")));
    parser.on("partsLimit", () => fail(new StoredFileServiceError("invalid_upload", "Upload must contain only one file part.")));
    parser.on("error", fail);
    parser.on("close", () => {
      if (settled) return;
      if (!filePromise) return fail(new StoredFileServiceError("invalid_upload", "Upload did not contain a file."));
      void filePromise.then((value) => {
        if (!settled) { settled = true; resolve(value); }
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

function isTextFile(file: StoredFileRecord): boolean {
  const extension = path.extname(file.filename).slice(1).toLowerCase();
  return file.mediaType.startsWith("text/") || TEXT_EXTENSIONS.has(extension) || file.filename.toLowerCase() === ".env";
}

function toInputMetadata(file: StoredFileRecord): StoredFileInputMetadata {
  return { file_id: file.id, filename: file.filename, media_type: file.mediaType, size: file.size };
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

async function listFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(target));
    else if (entry.isFile()) result.push(target);
  }
  return result;
}
