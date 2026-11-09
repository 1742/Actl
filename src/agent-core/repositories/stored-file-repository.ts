export interface StoredFileRecord {
  id: string;
  sessionId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdAt: string;
}

export interface StoredFileRepository {
  createStoredFile(file: StoredFileRecord): Promise<void>;
  getStoredFile(fileId: string): StoredFileRecord | undefined;
  listStoredFiles(sessionId: string): StoredFileRecord[];
  deleteExpiredUnboundFiles(olderThan: string): Promise<void>;
  listReferencedStorageKeys(): string[];
}
