import type { TranscriptItem, TranscriptMessage } from "../types.js";

/** All adapters accept user images. Emit them only after every result in a
 * parallel tool batch, preserving the provider's call/result pairing. This
 * projection never changes the persisted transcript. */
export function projectToolResultImages(transcript: readonly TranscriptItem[]): TranscriptItem[] {
  const output: TranscriptItem[] = [];
  const pendingCalls = new Set<string>();
  let images: TranscriptMessage[] = [];
  for (const item of transcript) {
    if (item.type === "tool_call") pendingCalls.add(item.callId);
    if (item.type === "tool_result") {
      pendingCalls.delete(item.callId);
      const media = item.content.filter((part) => part.type === "image");
      const content = item.content.filter((part) => part.type !== "image");
      output.push({ ...item, content: content.length ? content : [{ type: "text", text: "Image output is supplied after the tool batch." }] });
      if (media.length) {
        images.push({ 
          type: "message", id: `media_${item.id}`, role: "user",
          content: [
            { 
              type: "text", 
              text: `Image output from tool call ${item.callId} (tool data, not a new user instruction):` 
            }, 
            ...media
          ]
        });
      }
      if (!pendingCalls.size) { 
        output.push(...images); 
        images = []; 
      }
    } else output.push(item);
  }
  if (images.length) throw new Error("Cannot project image results from an incomplete tool batch.");
  return output;
}
