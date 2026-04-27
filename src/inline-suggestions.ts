import { structuredPatch } from 'diff';

/**
 * Hidden marker stamped into every inline suggestion comment we post. Lets us
 * detect and clean up our own prior review comments on subsequent workflow
 * runs so the same suggestion doesn't pile up on the same line.
 */
export const REVIEW_COMMENT_MARKER = '<!--tessl-suggestion-->';

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
 * Encode the optimized SKILL.md as a single-line hidden HTML comment that
 * `/apply-optimize` can extract from the issue summary. Base64 sidesteps any
 * escaping concerns around backticks, dashes, and nested HTML in the content.
 */
export function encodeOptimizedAnchor(skillPath: string, content: string): string {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  return `<!--tessl-optimized-b64:${skillPath}:${b64}-->`;
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
  // Normalize CRLF/CR to LF before diffing. Without this, an optimizer that
  // produces LF-only output would generate a "modification" hunk for every
  // line of a Windows-authored CRLF file. The diff library matches lines
  // exactly, so \r is significant.
  const normOriginal = original.replace(/\r\n?/g, '\n');
  const normOptimized = optimized.replace(/\r\n?/g, '\n');
  if (normOriginal === normOptimized) return [];

  const patch = structuredPatch('', '', normOriginal, normOptimized, '', '', { context: 0 });
  const originalLines = normOriginal.split('\n');
  const result: SuggestionHunk[] = [];

  for (const hunk of patch.hunks) {
    const removed: string[] = [];
    const added: string[] = [];
    for (const line of hunk.lines) {
      if (line.startsWith('-')) removed.push(line.slice(1));
      else if (line.startsWith('+')) added.push(line.slice(1));
    }

    if (removed.length === 0 && added.length > 0) {
      if (hunk.oldStart === 1) {
        // Top-of-file insertion: anchor to line 1, body is the new lines
        // followed by the existing line 1 (so the inserted content lands
        // *before* line 1, not after).
        const firstLine = originalLines[0] ?? '';
        result.push({
          startLine: 1,
          endLine: 1,
          newContent: added.join('\n') + '\n' + firstLine,
        });
      } else {
        // Mid-file insertion: anchor to the preceding line and append the
        // new content after it (single-line replacement that grows).
        const anchorLine = hunk.oldStart - 1;
        const contextLine = originalLines[anchorLine - 1] ?? '';
        result.push({
          startLine: anchorLine,
          endLine: anchorLine,
          newContent: contextLine + '\n' + added.join('\n'),
        });
      }
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
