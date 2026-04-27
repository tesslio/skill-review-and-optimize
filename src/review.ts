import * as github from '@actions/github';
import {
  computeSuggestionHunks,
  formatSuggestionBody,
} from './inline-suggestions.ts';
import type { SkillReviewResult } from './skill-review.ts';

/**
 * Post a single PR review per workflow run, with an inline `suggestion` block
 * for each diff hunk between the user's SKILL.md and the optimizer's version.
 *
 * Runs alongside the issue summary comment — does not replace it. On re-runs,
 * GitHub auto-marks prior reviews "Outdated" once the PR HEAD changes; we do
 * not dismiss them in v1.
 */
export async function postInlineSuggestions(
  results: SkillReviewResult[],
  commitId: string,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post inline suggestions');
  }

  const context = github.context;
  if (!context.payload.pull_request) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;

  for (const result of results) {
    const optimizedContent = result.optimize?.optimizedContent;
    if (!result.optimize?.optimized || !optimizedContent) continue;

    // The action restores the original file after optimize, so reading from
    // disk gives us the user's PR-head version that GitHub's diff view sees.
    const original = await Bun.file(result.skillPath).text();
    const hunks = computeSuggestionHunks(original, optimizedContent);
    if (hunks.length === 0) continue;

    const comments = hunks.map((hunk) => {
      const base = {
        path: result.skillPath,
        body: formatSuggestionBody(hunk.newContent),
        line: hunk.endLine,
        side: 'RIGHT' as const,
      };
      if (hunk.startLine !== hunk.endLine) {
        return {
          ...base,
          start_line: hunk.startLine,
          start_side: 'RIGHT' as const,
        };
      }
      return base;
    });

    const reviewBody =
      `Tessl optimizer found **${comments.length} suggestion${comments.length === 1 ? '' : 's'}** for \`${result.skillPath}\`, ` +
      `comparing your draft against the optimizer's improved version — anchored to lines in your file (visible on the right of the diff). ` +
      `Click "Commit suggestion" on each change you want to accept, or comment \`/apply-optimize\` to accept all at once.`;

    await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      commit_id: commitId,
      event: 'COMMENT',
      body: reviewBody,
      comments,
    });

    console.log(
      `Posted ${comments.length} inline suggestion(s) on ${result.skillPath}`,
    );
  }
}
