import type { WaitReceipt } from "../repositories/agent-coordination-repository.js";
import type { ContentPart } from "../model/types.js";

/** Explicit envelope for builtin outputs with model-visible content. */
export class RichToolOutput {
  constructor(readonly output: unknown, readonly content: ContentPart[]) {}
}

/** Internal receipt committed with the model-visible wait result. */
export class WaitToolOutput {
  constructor(readonly output: unknown, readonly receipt: WaitReceipt) {}
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
  waitReceipt?: WaitReceipt;
  error?: string;
}
