import { structuredPatch } from 'diff';

export interface SuggestionHunk {
  /** First line of the range in the original file (1-based). Anchor for GitHub. */
  startLine: number;
  /** Last line of the range in the original file (1-based). Same as startLine for single-line replacements. */
  endLine: number;
  /** Replacement content for the range. Empty string for pure deletions. */
  newContent: string;
}

/**
 * Pick a fence length long enough to safely wrap markdown content that may
 * itself contain ``` fences. GitHub renders nested fences correctly when the
 * outer fence is strictly longer than any inner fence.
 */
export function pickFenceLength(content: string): number {
  const matches = content.match(/^`{3,}/gm) ?? [];
  let max = 0;
  for (const m of matches) {
    if (m.length > max) max = m.length;
  }
  return Math.max(3, max + 1);
}

/**
 * Wrap a replacement body in a GitHub `suggestion` block. The fence length
 * adapts to any backtick fences inside the body.
 */
export function formatSuggestionBody(newContent: string, intro?: string): string {
  const fence = '`'.repeat(pickFenceLength(newContent));
  const introPart = intro ? `${intro}\n\n` : '';
  return `${introPart}${fence}suggestion\n${newContent}\n${fence}`;
}

/**
 * Compute hunks of change between original and optimized content, mapped to
 * GitHub suggestion-comment shape (anchored to lines in the original).
 *
 * Three hunk shapes handled:
 * - **Modification** (lines removed AND added): anchor the removed range,
 *   body is the new content.
 * - **Pure deletion** (lines removed, none added): anchor the removed range,
 *   body is empty.
 * - **Pure insertion** (none removed, lines added): GitHub can't anchor to
 *   "between lines", so we anchor to the preceding line and prepend it to the
 *   suggestion body — turning insertion into a single-line replacement.
 */
export function computeSuggestionHunks(
  original: string,
  optimized: string,
): SuggestionHunk[] {
  if (original === optimized) return [];

  const patch = structuredPatch('', '', original, optimized, '', '', { context: 0 });
  const originalLines = original.split('\n');
  const result: SuggestionHunk[] = [];

  for (const hunk of patch.hunks) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
    }

    if (removed.length === 0 && added.length > 0) {
      // Pure insertion: anchor to the preceding line (hunk.oldStart - 1 in
      // 1-based; clamp to 1 if at file start) and prepend its content to the
      // suggestion so GitHub treats it as a single-line replacement.
      const anchorLine = Math.max(1, hunk.oldStart - 1);
      const contextLine = originalLines[anchorLine - 1] ?? '';
      result.push({
        startLine: anchorLine,
        endLine: anchorLine,
        newContent: contextLine + '\n' + added.join('\n'),
      });
    } else if (removed.length > 0 && added.length === 0) {
      result.push({
        startLine: hunk.oldStart,
        endLine: hunk.oldStart + removed.length - 1,
        newContent: '',
      });
    } else if (removed.length > 0 && added.length > 0) {
      result.push({
        startLine: hunk.oldStart,
        endLine: hunk.oldStart + removed.length - 1,
        newContent: added.join('\n'),
      });
    }
  }

  return result;
}
