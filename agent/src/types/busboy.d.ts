declare module "busboy" {
  import type { IncomingHttpHeaders } from "node:http";
  import type { Readable, Writable } from "node:stream";

  interface BusboyFileStream extends Readable {
    truncated: boolean;
  }

  interface BusboyFileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  interface BusboyLimits {
    fileSize?: number;
    files?: number;
    fields?: number;
    parts?: number;
  }

  interface BusboyConfig {
    headers: IncomingHttpHeaders;
    limits?: BusboyLimits;
    defParamCharset?: string;
  }

  interface BusboyParser extends Writable {
    on(event: "file", listener: (fieldname: string, file: BusboyFileStream, info: BusboyFileInfo) => void): this;
    on(event: "filesLimit" | "fieldsLimit" | "partsLimit", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: () => void): this;
  }

  export default function busboy(config: BusboyConfig): BusboyParser;
}
