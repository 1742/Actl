export interface RuntimeWorkspaceFile {
  type: "workspace_file";
  path: string;
  name: string;
}

export interface RuntimeWorkspaceFileSearchResult {
  data: RuntimeWorkspaceFile[];
  truncated: boolean;
}

export interface RuntimeWorkspaceDirectoryEntry {
  type: "file" | "directory";
  name: string;
  path: string;
}

export interface RuntimeWorkspaceTree {
  path: string;
  entries: RuntimeWorkspaceDirectoryEntry[];
  truncated: boolean;
}

export type WorkspaceFilePreview =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mediaType: string; bytes: Uint8Array }
  | { kind: 'missing' | 'unsupported' | 'too-large' };
