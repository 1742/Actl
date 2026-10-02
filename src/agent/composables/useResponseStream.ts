export interface SSEFrame {
  data: string;
  event?: string;
  done?: boolean;
}

interface FrameEnd {
  index: number;
  length: number;
}

export class ResponseStreamParser {
  private buffer = "";

  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const events: SSEFrame[] = [];

    while (true) {
      const splitIndex = this.findFrameEnd();
      if (!splitIndex) break;

      const frame = this.buffer.slice(0, splitIndex.index);
      this.buffer = this.buffer.slice(splitIndex.index + splitIndex.length);

      const event = this.parseFrame(frame);
      if (event) events.push(event);
    }

    return events;
  }

  flush(): SSEFrame[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }

    const event = this.parseFrame(this.buffer);
    this.buffer = "";
    return event ? [event] : [];
  }

  private findFrameEnd(): FrameEnd | null {
    const lfIndex = this.buffer.indexOf("\n\n");
    const crlfIndex = this.buffer.indexOf("\r\n\r\n");

    if (lfIndex === -1 && crlfIndex === -1) return null;
    if (lfIndex === -1) return { index: crlfIndex, length: 4 };
    if (crlfIndex === -1) return { index: lfIndex, length: 2 };

    return lfIndex < crlfIndex
      ? { index: lfIndex, length: 2 }
      : { index: crlfIndex, length: 4 };
  }

  private parseFrame(frame: string): SSEFrame | null {
    let event: string | undefined;
    const dataLines: string[] = [];
    const rawDataLines: string[] = [];

    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;

      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      } else {
        rawDataLines.push(line);
      }
    }

    const data = dataLines.length ? dataLines.join("\n") : rawDataLines.join("\n").trim();
    if (!data) return null;
    if (data === "[DONE]") return { event: "done", data, done: true };

    return { event, data };
  }
}
