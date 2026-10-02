import { tr } from '../../i18n';
import { useRuntimeStore } from '../../stores/runtime';
import { bridge } from '../../services/bridge';

export interface BrowserPickedFile {
  source: 'browser';
  file: File;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
}

export type PickedFile = BrowserPickedFile;

export interface PickFilesOptions {
  accept?: string[];
  multiple?: boolean;
  purpose: string;
}

export interface UploadFilePart {
  field: string;
  selected: PickedFile;
  filename?: string;
}

export interface RemoteUploadFilePart {
  field: string;
  url: string;
  filename: string;
}

export interface UploadFilesRequest {
  target?: 'agent';
  route: string;
  method?: 'POST' | 'PUT';
  fields?: Record<string, unknown>;
  files: UploadFilePart[];
  remoteFiles?: RemoteUploadFilePart[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

function toPickedFile(file: File): BrowserPickedFile {
  return {
    source: 'browser',
    file,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

function selectFiles(options: PickFilesOptions): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = Boolean(options.multiple);
    input.accept = options.accept?.join(',') || '';
    const finish = () => {
      resolve(Array.from(input.files || [], toPickedFile));
      input.remove();
    };
    input.addEventListener('change', finish, { once: true });
    input.click();
  });
}

export function pickFiles(options: PickFilesOptions) {
  return selectFiles(options);
}

export async function pickDirectory(): Promise<string | undefined> {
  return (await bridge.pickDirectory()) || undefined;
}

export async function uploadFiles<T>(request: UploadFilesRequest): Promise<T> {
  const formData = new FormData();
  let totalBytes = 0;
  for (const [key, value] of Object.entries(request.fields || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && item !== undefined)
        formData.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  for (const part of request.files) {
    if (request.maxFileBytes !== undefined && part.selected.size > request.maxFileBytes)
      throw new Error(tr('dynamic.fileTooLarge', { name: part.filename || part.selected.name }));
    totalBytes += part.selected.size;
    formData.append(part.field, part.selected.file, part.filename || part.selected.name);
  }
  for (const part of request.remoteFiles || []) {
    const response = await fetch(part.url);
    if (!response.ok)
      throw new Error(
        tr('dynamic.fetchRemoteFailed', { name: part.filename, status: response.status }),
      );
    const blob = await response.blob();
    if (request.maxFileBytes !== undefined && blob.size > request.maxFileBytes)
      throw new Error(tr('dynamic.fileTooLarge', { name: part.filename }));
    totalBytes += blob.size;
    formData.append(part.field, blob, part.filename);
  }
  if (request.maxTotalBytes !== undefined && totalBytes > request.maxTotalBytes)
    throw new Error(tr('ui.totalUploadSizeExceedsTheLimit'));
  const runtime = useRuntimeStore();
  const response = await fetch(`${runtime.agentUrl}${request.route}`, {
    method: request.method || 'POST',
    headers: runtime.agentToken ? { 'X-Actl-Agent-Token': runtime.agentToken } : {},
    body: formData,
  });
  if (!response.ok) throw new Error(tr('dynamic.uploadFailed', { status: response.status }));
  return (await response.json()) as T;
}

export function releaseSelections(_files: PickedFile[]) {
  return Promise.resolve();
}

export function previewUrl(file: PickedFile) {
  return URL.createObjectURL(file.file);
}

export function revokePreviewUrl(_file: PickedFile, url: string) {
  URL.revokeObjectURL(url);
}
