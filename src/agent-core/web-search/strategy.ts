import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import type { RuntimeWebSearchSettings, WebSearchProvider } from "../../shared/agent/web-search.js";

export type WebSearchExecutionStrategy =
  | { kind: "native"; provider: "openai_responses" }
  | { kind: "external"; provider: WebSearchProvider }
  | { kind: "unavailable"; reason: "disabled" | "native_unsupported" | "credential_missing" };

export function resolveWebSearchExecutionStrategy(
  settings: RuntimeWebSearchSettings,
  model: ModelExecutionSnapshot,
): WebSearchExecutionStrategy {
  if (!settings.enabled) return { kind: "unavailable", reason: "disabled" };
  const nativeProvider = nativeWebSearchProvider(model);
  if (settings.mode !== "external" && nativeProvider) return { kind: "native", provider: nativeProvider };
  if (settings.mode === "native") return { kind: "unavailable", reason: "native_unsupported" };
  if (!settings.hasCredential) return { kind: "unavailable", reason: "credential_missing" };
  return { kind: "external", provider: settings.provider };
}

function nativeWebSearchProvider(model: ModelExecutionSnapshot): "openai_responses" | null {
  return model.protocol === "responses" && model.capabilities.nativeWebSearch ? "openai_responses" : null;
}
