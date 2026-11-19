import type { TranscriptItem } from "../model/types.js";

export interface SelectedSkillMetadata {
  id: string;
  name: string;
  description: string;
}

/**
 * Replay the metadata captured when the user selected the Skill, including
 * when the message is reloaded or the installed Skill has since changed.
 */
export function materializeSelectedSkillReferences(
  transcript: readonly TranscriptItem[],
): TranscriptItem[] {
  return transcript.map((item): TranscriptItem => {
    if (item.type !== "message") return item;
    const referenced: SelectedSkillMetadata[] = [];
    const seen = new Set<string>();
    const content = item.content.map((part) => {
      if (part.type !== "skill") return part;
      const name = part.name ?? part.id;
      if (item.role === "user" && part.description !== undefined && !seen.has(part.id)) {
        referenced.push({ id: part.id, name, description: part.description });
        seen.add(part.id);
      }
      return {
        type: "text" as const,
        text: `skill:${name}`,
      };
    });
    if (referenced.length > 0) {
      content.push({
        type: "text",
        text: `\n\n${referenced.map(formatSelectedSkillReference).join("\n\n")}`,
      });
    }
    return { ...item, content };
  });
}

function formatSelectedSkillReference(skill: SelectedSkillMetadata): string {
  return [
    "<selected_skill_reference>",
    JSON.stringify({
      skill_id: skill.id,
      name: skill.name,
      description: skill.description,
    }),
    "</selected_skill_reference>",
  ].join("\n");
}
