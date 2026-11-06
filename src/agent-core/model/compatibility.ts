import type { ModelCapabilities } from "./catalog-types.js";
import type { TranscriptItem } from "./types.js";

export function findModelCompatibilityIssues(
  transcript: readonly TranscriptItem[],
  capabilities: ModelCapabilities,
): string[] {
  const unsupported = new Set<string>();
  for (const item of transcript) {
    if ((item.type === "tool_call" || item.type === "tool_result") && !capabilities.toolCalling) unsupported.add("tool_history");
    if (item.type !== "message" && item.type !== "tool_result") continue;
    for (const part of item.content) {
      if (part.type === "image") {
        const mediaType = part.source.type === "data" ? part.source.mediaType : "image/*";
        if (!supportsMime(capabilities.input.imageMimeTypes, mediaType)) unsupported.add(`image:${mediaType}`);
      }
      if (part.type === "audio") {
        const mediaType = part.source.type === "data" ? part.source.mediaType : `audio/${part.format}`;
        if (!supportsMime(capabilities.input.audioMimeTypes, mediaType)) unsupported.add(`audio:${mediaType}`);
      }
      if (part.type === "file") {
        const mediaType = part.mediaType ?? "application/octet-stream";
        unsupported.add(`file:${mediaType}`);
      }
    }
  }
  return [...unsupported];
}

export function supportsMime(supported: readonly string[], actual: string): boolean {
  return supported.some((value) => value === actual || value === "*/*"
    || (actual.endsWith("/*") && value.startsWith(actual.slice(0, -1)))
    || (value.endsWith("/*") && actual.startsWith(value.slice(0, -1))));
}
