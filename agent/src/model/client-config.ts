import type { ModelProtocol } from "./types.js";

export interface ModelClientConfig {
  model: string;
  baseURL: string;
  apiKey: string;
  protocol: ModelProtocol;
  /** Timeout for individual model API requests in milliseconds (default 300000). */
  timeoutMs?: number;
}
