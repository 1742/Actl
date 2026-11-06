import type { ModelProtocol, ModelTurnEvent, ModelTurnRequest, ModelTurnResult } from "./types.js";

export type ModelTurnEventHandler = (event: ModelTurnEvent) => void | Promise<void>;

export interface ModelTurnOptions {
  signal?: AbortSignal;
}

export interface ModelClient {
  readonly protocol: ModelProtocol;
  runTurn(request: ModelTurnRequest, onEvent: ModelTurnEventHandler, options?: ModelTurnOptions): Promise<ModelTurnResult>;
}

