

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

export function releaseSelections(_files: PickedFile[]) {
  return Promise.resolve();
}

export function previewUrl(file: PickedFile) {
  return URL.createObjectURL(file.file);
}

export function revokePreviewUrl(_file: PickedFile, url: string) {
  URL.revokeObjectURL(url);
}
