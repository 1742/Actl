import type { TranscriptItem, TranscriptMessage } from "../model/types.js";

/** Keep historical MCP references compact and describe only current selections. */
export function materializeSelectedMcpReferences(
  transcript: readonly TranscriptItem[],
  currentInput: readonly TranscriptMessage[],
  selectedServers: readonly string[],
): TranscriptItem[] {
  const currentMessageIds = new Set(currentInput.map((message) => message.id));
  const selected = new Set(selectedServers);

  return transcript.map((item): TranscriptItem => {
    if (item.type !== "message") return structuredClone(item);
    const referenced: string[] = [];
    const seen = new Set<string>();
    const content = item.content.map((part) => {
      if (part.type !== "mcp_server") return structuredClone(part);
      if (currentMessageIds.has(item.id) && selected.has(part.name) && !seen.has(part.name)) {
        referenced.push(part.name);
        seen.add(part.name);
      }
      return { type: "text" as const, text: `mcp:${part.name}` };
    });
    if (referenced.length) {
      content.push({
        type: "text",
        text: `\n\n${referenced.map((server) => `<selected_mcp_reference>\n${JSON.stringify({ server })}\n</selected_mcp_reference>`).join("\n\n")}`,
      });
    }
    return { ...structuredClone(item), content };
  });
}
