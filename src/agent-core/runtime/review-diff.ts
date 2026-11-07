import type { ReviewLine } from "../../shared/agent/review.js";

// Preserve line endings so a change to the final newline is still visible.
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function reviewDiff(before: string, after: string, includeLines: boolean) {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const width = newEnd - start + 1;
  const cells = (oldEnd - start + 1) * width;
  // Large replacements still get a valid diff without quadratic time or memory.
  const matches = cells <= 2_000_000 ? new Uint32Array(cells) : undefined;
  if (matches) {
    for (let old = oldEnd - 1; old >= start; old--) {
      for (let next = newEnd - 1; next >= start; next--) {
        const offset = (old - start) * width + next - start;
        matches[offset] = oldLines[old] === newLines[next]
          ? 1 + matches[offset + width + 1]!
          : Math.max(matches[offset + 1]!, matches[offset + width]!);
      }
    }
  }
  const additions = newEnd - start - (matches?.[0] ?? 0);
  const deletions = oldEnd - start - (matches?.[0] ?? 0);
  const lines: ReviewLine[] = [];
  if (!includeLines || (!additions && !deletions)) return { additions, deletions, lines };

  const context = (old: number, next: number): ReviewLine => ({
    kind: "context", text: oldLines[old]!, oldLine: old + 1, newLine: next + 1,
  });
  const gap: ReviewLine = { kind: "gap", text: "" };
  if (start > 3) lines.push(gap);
  for (let i = Math.max(0, start - 3); i < start; i++) lines.push(context(i, i));

  let old = start;
  let next = start;
  while ((old < oldEnd || next < newEnd) && lines.length < 2_000) {
    const offset = (old - start) * width + next - start;
    if (matches && old < oldEnd && next < newEnd && oldLines[old] === newLines[next]) {
      const oldStart = old;
      const newStart = next;
      while (old < oldEnd && next < newEnd && oldLines[old] === newLines[next]) {
        old++;
        next++;
      }
      for (let i = oldStart; i < Math.min(old, oldStart + 3); i++) lines.push(context(i, newStart + i - oldStart));
      if (old - oldStart > 6) lines.push(gap);
      for (let i = Math.max(oldStart + 3, old - 3); i < old; i++) lines.push(context(i, next + i - old));
    } else if (old < oldEnd && (next === newEnd || !matches || matches[offset + width]! >= matches[offset + 1]!)) {
      lines.push({ kind: "removed", text: oldLines[old]!, oldLine: ++old });
    } else {
      lines.push({ kind: "added", text: newLines[next]!, newLine: ++next });
    }
  }
  if (old < oldEnd || next < newEnd) lines.push(gap);
  else {
    const remaining = oldLines.length - oldEnd;
    for (let i = 0; i < Math.min(3, remaining); i++) lines.push(context(oldEnd + i, newEnd + i));
    if (remaining > 3) lines.push(gap);
  }
  return { additions, deletions, lines };
}
