import type { ModelClientConfig } from "../client-config.js";
import type { ModelClient, ModelTurnEventHandler, ModelTurnOptions } from "../client.js";
import type { ModelTurnRequest, ModelTurnResult } from "../types.js";
import { ChatCompletionsDriverBase, ResponsesDriverBase } from "./base.js";

export class OpenAICompatibleDriver implements ModelClient {
  readonly protocol: ModelClient["protocol"];
  private readonly delegate: ModelClient;

  constructor(config: ModelClientConfig) {
    if (config.protocol === "anthropic_messages") throw new Error("Anthropic Messages requires its dedicated driver.");
    this.delegate = config.protocol === "responses"
      ? new ResponsesDriverBase(config)
      : new ChatCompletionsDriverBase(config);
    this.protocol = this.delegate.protocol;
  }

  runTurn(request: ModelTurnRequest, onEvent: ModelTurnEventHandler, options?: ModelTurnOptions): Promise<ModelTurnResult> {
    return this.delegate.runTurn(request, onEvent, options);
  }
}
