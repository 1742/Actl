import type { ContentPart } from "../model/types.js";

/** Explicit envelope for builtin outputs with model-visible content. */
export class RichToolOutput {
  constructor(readonly output: unknown, readonly content: ContentPart[]) {}
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  output?: unknown;
  content?: ContentPart[];
  error?: string;
}
