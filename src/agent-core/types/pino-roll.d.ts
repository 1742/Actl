declare module "pino-roll" {
  import type { Writable } from "node:stream";

  interface PinoRollOptions {
    file: string;
    extension?: string;
    frequency?: "daily" | "hourly" | number;
    size?: string | number;
    mkdir?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<Writable>;
}
