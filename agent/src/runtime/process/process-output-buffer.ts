import type { ProcessOutputChunk } from "./process-types.js";

export interface ProcessOutputRead {
  chunks: ProcessOutputChunk[];
  nextCursor: number;
  nextLine: number;
  truncated: boolean;
}

export class ProcessOutputBuffer {
  private readonly chunks: Array<ProcessOutputChunk & { bytes: number; startLine: number; lineBoundary: boolean }> = [];
  private bytes = 0;
  private nextCursor = 1;
  private nextLine = 1;
  private endsWithNewline = true;
  private discardedThroughCursor = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError("Process output buffer size must be a positive integer.");
    }
  }

  append(stream: "stdout" | "stderr", text: string): void {
    if (text.length === 0) return;
    let normalized = text;
    let byteLength = Buffer.byteLength(normalized);
    let startLine = this.nextLine;
    let lineBoundary = this.endsWithNewline;
    this.nextLine += countNewlines(text);
    this.endsWithNewline = text.endsWith("\n");
    if (byteLength > this.maxBytes) {
      this.discardedThroughCursor = this.nextCursor;
      normalized = utf8Tail(normalized, this.maxBytes);
      const removedPrefix = text.slice(0, text.length - normalized.length);
      startLine += countNewlines(removedPrefix);
      lineBoundary = removedPrefix.length > 0 ? removedPrefix.endsWith("\n") : lineBoundary;
      byteLength = Buffer.byteLength(normalized);
    }
    this.chunks.push({ cursor: this.nextCursor, stream, text: normalized, bytes: byteLength, startLine, lineBoundary });
    this.nextCursor += 1;
    this.bytes += byteLength;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      if (removed) {
        this.bytes -= removed.bytes;
        this.discardedThroughCursor = Math.max(this.discardedThroughCursor, removed.cursor);
      }
    }
  }

  readAfter(cursor = 0): ProcessOutputRead {
    const truncated = cursor < this.discardedThroughCursor;
    return {
      chunks: this.chunks
        .filter((chunk) => chunk.cursor > cursor)
        .map(({ bytes: _bytes, startLine: _startLine, lineBoundary: _lineBoundary, ...chunk }) => ({ ...chunk })),
      nextCursor: this.nextCursor - 1,
      nextLine: this.nextLine,
      truncated,
    };
  }

  readFromLine(line: number): ProcessOutputRead {
    const first = this.chunks[0];
    const truncated = first !== undefined && (line < first.startLine || (line === first.startLine && !first.lineBoundary));
    const chunks: ProcessOutputChunk[] = [];
    for (const chunk of this.chunks) {
      let text = chunk.text;
      if (line > chunk.startLine) {
        let remaining = line - chunk.startLine;
        let offset = 0;
        while (remaining > 0) {
          const newline = text.indexOf("\n", offset);
          if (newline < 0) break;
          offset = newline + 1;
          remaining -= 1;
        }
        if (remaining > 0 || offset === text.length) continue;
        text = text.slice(offset);
      }
      chunks.push({ cursor: chunk.cursor, stream: chunk.stream, text });
    }
    return { chunks, nextCursor: this.nextCursor - 1, nextLine: this.nextLine, truncated };
  }
}

function countNewlines(text: string): number {
  let count = 0;
  for (const character of text) if (character === "\n") count += 1;
  return count;
}

function utf8Tail(value: string, maxBytes: number): string {
  const characters = Array.from(value);
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const characterBytes = Buffer.byteLength(characters[start - 1]!);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    start -= 1;
  }
  return characters.slice(start).join("");
}
