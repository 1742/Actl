import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import type { WebSearchSettingsView } from "./types.js";

export type WebSearchExecutionStrategy =
  | { kind: "native"; provider: "openai_responses" }
  | { kind: "external"; provider: "brave" | "tavily" | "serper" | "bocha" }
  | { kind: "unavailable"; reason: "disabled" | "native_unsupported" | "credential_missing" };

export function resolveWebSearchExecutionStrategy(
  settings: WebSearchSettingsView,
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
