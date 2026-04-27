import * as github from '@actions/github';
import {
  REVIEW_COMMENT_MARKER,
  computeSuggestionHunks,
  filterHunksToPatchRanges,
  formatSuggestionBody,
  parsePatchRanges,
} from './inline-suggestions.ts';
import type { SkillReviewResult } from './skill-review.ts';

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Delete prior inline suggestion comments posted by this action so re-runs
 * don't pile up duplicate suggestions on the same line. Identified via the
 * REVIEW_COMMENT_MARKER stamped into every body we post.
 */
async function deletePriorSuggestions(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  let page = 1;
  const ours: number[] = [];
  while (true) {
    const { data } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    for (const c of data) {
      // SECURITY: only delete bot-authored comments. A human reviewer who
      // quotes the marker (e.g. via "Quote reply") must not have their
      // comment silently deleted.
      if (c.user?.type === 'Bot' && c.body?.includes(REVIEW_COMMENT_MARKER)) {
        ours.push(c.id);
      }
    }
    if (data.length < 100) break;
    page++;
  }
  for (const commentId of ours) {
    try {
      await octokit.rest.pulls.deleteReviewComment({
        owner,
        repo,
        comment_id: commentId,
      });
    } catch {
      // Already deleted or otherwise inaccessible. Ignore.
    }
  }
  if (ours.length > 0) {
    console.log(`Cleaned up ${ours.length} prior suggestion comment(s)`);
  }
}

/**
 * Post a single PR review per workflow run, with an inline `suggestion` block
 * for each diff hunk between the user's SKILL.md and the optimizer's version.
 *
 * Runs alongside the issue summary comment, does not replace it. Prior bot
 * suggestion comments are deleted before posting so the same suggestion
 * doesn't accumulate on the same line across re-runs.
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
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  await deletePriorSuggestions(octokit, owner, repo, prNumber);

  // Fetch the PR's file list once so we can scope inline suggestions to
  // lines that GitHub considers part of the diff. Suggestions on unchanged
  // lines are rejected with "Line could not be resolved".
  const prFiles = new Map<string, string>();
  let filesPage = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page: filesPage,
    });
    for (const f of data) {
      if (f.patch) prFiles.set(f.filename, f.patch);
    }
    if (data.length < 100) break;
    filesPage++;
  }

  for (const result of results) {
    const optimizedContent = result.optimize?.optimizedContent;
    if (!result.optimize?.optimized || !optimizedContent) continue;

    // The action restores the original file after optimize, so reading from
    // disk gives us the user's PR-head version that GitHub's diff view sees.
    const original = await Bun.file(result.skillPath).text();
    const allHunks = computeSuggestionHunks(original, optimizedContent);
    if (allHunks.length === 0) continue;

    // Drop hunks targeting lines outside the PR diff — GitHub would reject
    // them and the whole batched review with them.
    const patch = prFiles.get(result.skillPath) ?? '';
    const ranges = parsePatchRanges(patch);
    const hunks = filterHunksToPatchRanges(allHunks, ranges);
    if (hunks.length === 0) {
      console.log(
        `${result.skillPath}: ${allHunks.length} optimizer hunk(s) all fall outside the PR diff. Skipping inline suggestions for this file.`,
      );
      continue;
    }

    const comments = hunks.map((hunk) => {
      const base = {
        path: result.skillPath,
        body: `${REVIEW_COMMENT_MARKER}\n${formatSuggestionBody(hunk.newContent)}`,
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

    const filesUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}/files`;
    const reviewBody =
      `**${comments.length} suggestion${comments.length === 1 ? '' : 's'}** on \`${result.skillPath}\`. Review on the [Files changed](${filesUrl}) tab.`;

    await octokit.rest.pulls.createReview({
      owner,
      repo,
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
