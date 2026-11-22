import type { ModelExecutionSnapshot } from "../model/catalog-types.js";
import { getNativeWebSearchType } from "../../shared/agent/models.js";
import type { RuntimeWebSearchSettings, WebSearchProvider } from "../../shared/agent/web-search.js";

export type WebSearchExecutionStrategy =
  | { kind: "native"; toolType: string }
  | { kind: "external"; provider: WebSearchProvider }
  | { kind: "unavailable"; reason: "disabled" | "native_unsupported" | "credential_missing" };

export function resolveWebSearchExecutionStrategy(
  settings: RuntimeWebSearchSettings,
  model: ModelExecutionSnapshot,
): WebSearchExecutionStrategy {
  if (!settings.enabled) return { kind: "unavailable", reason: "disabled" };
  const toolType = getNativeWebSearchType(model.protocol, model.capabilities);
  if (settings.mode !== "external" && toolType) return { kind: "native", toolType };
  if (settings.mode === "native") return { kind: "unavailable", reason: "native_unsupported" };
  if (!settings.hasCredential) return { kind: "unavailable", reason: "credential_missing" };
  return { kind: "external", provider: settings.provider };
}
