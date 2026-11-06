import type { TranscriptItem, TranscriptMessage } from "../model/types.js";

export interface SelectedSkillMetadata {
  id: string;
  name: string;
  description: string;
}

/**
 * Projects structured Skill references into model-readable text. Historical
 * references stay as compact markers. References in the current run also get
 * a lightweight metadata block appended to the containing user message; the
 * full Skill instructions remain available on demand through a tool.
 */
export function materializeSelectedSkillReferences(
  transcript: readonly TranscriptItem[],
  currentInput: readonly TranscriptMessage[],
  selectedSkills: readonly SelectedSkillMetadata[],
): TranscriptItem[] {
  const currentMessageIds = new Set(currentInput.map((message) => message.id));
  const skillsById = new Map(selectedSkills.map((skill) => [skill.id, skill]));

  return transcript.map((item): TranscriptItem => {
    if (item.type !== "message") return structuredClone(item);
    const isCurrentInput = currentMessageIds.has(item.id);
    const referenced: SelectedSkillMetadata[] = [];
    const seen = new Set<string>();
    const content = item.content.map((part) => {
      if (part.type !== "skill") return structuredClone(part);
      const skill = skillsById.get(part.id);
      if (isCurrentInput && skill && !seen.has(skill.id)) {
        referenced.push(skill);
        seen.add(skill.id);
      }
      return {
        type: "text" as const,
        text: `skill:${skill?.name ?? part.name ?? part.id}`,
      };
    });
    if (referenced.length > 0) {
      content.push({
        type: "text",
        text: `\n\n${referenced.map(formatSelectedSkillReference).join("\n\n")}`,
      });
    }
    return { ...structuredClone(item), content };
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
