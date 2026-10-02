import type { ModelClientConfig } from "./client-config.js";
import type { ModelClient } from "./client.js";
import { OpenAICompatibleDriver } from "./drivers/openai-compatible.js";
import { AnthropicMessagesDriver } from "./drivers/anthropic-messages.js";

export function createModelClient(config: ModelClientConfig): ModelClient {
  if (config.protocol === "anthropic_messages") return new AnthropicMessagesDriver(config);
  return new OpenAICompatibleDriver(config);
}
