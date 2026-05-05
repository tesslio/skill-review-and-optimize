import * as github from '@actions/github';

/**
 * Web-flow is the committer GitHub uses when a commit is created through the
 * web UI — including the "Commit suggestion" / "Commit suggestions" buttons
 * on a PR review. Both signals (committer identity AND message shape) are
 * required so we don't accidentally skip e.g. a plain web edit of an unrelated
 * file.
 */
const WEB_FLOW_NAME = 'GitHub';
const WEB_FLOW_EMAIL = 'noreply@github.com';

/**
 * Two distinct message shapes are produced by the GitHub web UI:
 *
 * - **Batch** (`Commit suggestions` after batching multiple via
 *   `Add suggestion to batch`): subject `Apply suggestions from code review`.
 * - **Single** (`Commit suggestion` on one inline block): subject
 *   `Update <filepath>` *with* a `Co-authored-by:` trailer attributing the
 *   suggestion's author. The trailer is what distinguishes a suggestion
 *   accept from a plain web edit (the pencil "Edit this file" button), which
 *   produces the same `Update <filepath>` subject without a co-author.
 */
function isSuggestionMessage(message: string): boolean {
  if (/^Apply suggestions? from code review\b/i.test(message)) return true;
  const isUpdateSubject = /^Update [^\n]+/.test(message);
  const hasCoAuthor = /\r?\nCo-authored-by:/i.test(message);
  return isUpdateSubject && hasCoAuthor;
}

/**
 * Returns true when the PR head commit looks like an accepted inline
 * suggestion. Used to short-circuit re-review when the consumer has opted out
 * via the `re-review-on-suggestion-acceptance` input.
 *
 * Soft-fails (returns false) on missing token, missing PR context, or API
 * errors — the caller treats a `false` result as "not a suggestion accept,
 * proceed with review", which is the safe default.
 */
export async function isSuggestionAcceptanceCommit(): Promise<boolean> {
  const sha = github.context.payload.pull_request?.head?.sha as string | undefined;
  if (!sha) return false;

  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  let data: Awaited<ReturnType<typeof octokit.rest.repos.getCommit>>['data'];
  try {
    const response = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    data = response.data;
  } catch {
    return false;
  }

  const committer = data.commit.committer;
  const message = data.commit.message ?? '';

  // Require GitHub's own GPG signature so a PR author cannot forge web-flow
  // committer identity (name + email) in a locally-crafted commit to trick the
  // action into skipping review. GitHub-signed commits have verified=true;
  // locally-forged commits do not, even with matching name/email.
  // If the GitHub signature-verification service is unavailable (verified=false,
  // reason='gpgverify_unavailable'), we fall through and keep reviewing — the
  // same safe default as API errors.
  const isWebFlow =
    committer?.name === WEB_FLOW_NAME &&
    committer?.email === WEB_FLOW_EMAIL &&
    data.commit.verification?.verified === true;
  if (!isWebFlow) return false;

  return isSuggestionMessage(message);
}
