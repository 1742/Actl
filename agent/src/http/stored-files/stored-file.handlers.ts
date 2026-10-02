import type { Request, Response } from "express";
import type { StoredFileService } from "../../stored-files/stored-file-service.js";
import type { WorkspaceStore } from "../../runtime/workspace-store.js";
import { ApiError } from "../common/api-error.js";
import { validated } from "../common/validation.js";
import type { SessionParams } from "../sessions/session.schemas.js";
import type { StoredFileParams } from "./stored-file.schemas.js";
import { currentOwnerId } from "../../auth/runtime-auth.js";

export interface StoredFileHandlerDependencies {
  workspaceStore: WorkspaceStore;
  storedFiles: StoredFileService;
}

export function createStoredFileHandlers({ workspaceStore, storedFiles }: StoredFileHandlerDependencies) {
  const requireSession = async (response: Response): Promise<string> => {
    const { sessionId } = validated<SessionParams>(response, "params");
    if (!await workspaceStore.getSession(sessionId, currentOwnerId(response))) throw new ApiError(404, "session_not_found", "Session not found.");
    return sessionId;
  };

  return {
    async upload(request: Request, response: Response): Promise<void> {
      const sessionId = await requireSession(response);
      response.status(201).json(toStoredFileDto(await storedFiles.upload(sessionId, request)));
    },

    async list(_request: Request, response: Response): Promise<void> {
      const sessionId = await requireSession(response);
      response.json({ data: storedFiles.list(sessionId).map(toStoredFileDto) });
    },

    async get(_request: Request, response: Response): Promise<void> {
      const sessionId = await requireSession(response);
      const { fileId } = validated<StoredFileParams>(response, "params");
      response.json(toStoredFileDto(storedFiles.getForSession(sessionId, fileId)));
    },

    async download(_request: Request, response: Response): Promise<void> {
      const sessionId = await requireSession(response);
      const { fileId } = validated<StoredFileParams>(response, "params");
      const stored = storedFiles.contentPath(sessionId, fileId);
      response.type(stored.file.mediaType);
      await new Promise<void>((resolve, reject) => {
        response.download(stored.path, stored.file.filename, (error) => error ? reject(error) : resolve());
      });
    },
  };
}

function toStoredFileDto(file: ReturnType<StoredFileService["getForSession"]>) {
  return {
    id: file.id,
    object: "stored_file",
    session_id: file.sessionId,
    filename: file.filename,
    media_type: file.mediaType,
    size: file.size,
    created_at: file.createdAt,
  };
}
