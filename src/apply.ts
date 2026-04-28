import * as core from '@actions/core';
import * as github from '@actions/github';
import * as path from 'node:path';
import { COMMENT_MARKER } from './comment.ts';

/**
 * Extract optimized content blocks from a skill-review comment.
 * Returns a map of skillPath -> optimized content.
 */
/**
 * Extract the "Key improvements" bullet points from the review comment.
 */
function extractKeyImprovements(body: string): string[] {
  const section = body.match(/\*\*Key improvements:\*\*\n((?:- .+\n?)+)/);
  if (!section) return [];
  return [...section[1]!.matchAll(/^- (.+)$/gm)].map(m => m[1]!);
}

/**
 * Parse the optional skill path from an `/apply-optimize` trigger comment.
 *
 * Returns the path only when the token after `/apply-optimize` actually looks
 * like a SKILL.md path. This preserves the original "apply all" behavior for
 * chatty comments like:
 *
 *   "Hey, can you /apply-optimize when you get a chance?"
 *
 * which the workflow's `contains(...)` filter will still trigger but should
 * not be mistakenly read as `/apply-optimize when`.
 */
export function parseRequestedPath(commentBody: string): string | undefined {
  // `/i` flag accepts /Apply-Optimize, /APPLY-OPTIMIZE, etc.
  const match = commentBody.match(/\/apply-optimize[ \t]+(\S+)/i);
  const candidate = match?.[1];
  // Case-insensitive SKILL.md suffix check forgives common typos like
  // `discovery/skill.MD` or `discovery/Skill.md` — we still preserve the
  // original casing of the candidate; the case-insensitive lookup against
  // the optimized map happens in apply().
  return candidate?.toLowerCase().endsWith('skill.md') ? candidate : undefined;
}

/**
 * Find an entry in the optimized map by case-insensitive path match. Returns
 * the canonical key (as stored by the bot's comment markers) so the actual
 * file write uses the trusted casing — important on case-sensitive
 * filesystems like the GitHub Actions Linux runner.
 */
export function findOptimizedEntry(
  optimized: Map<string, string>,
  requestedPath: string,
): { key: string; content: string } | undefined {
  const target = requestedPath.toLowerCase();
  for (const [key, content] of optimized) {
    if (key.toLowerCase() === target) return { key, content };
  }
  return undefined;
}

function extractOptimizedContent(body: string): Map<string, string> {
  const results = new Map<string, string>();

  // Current format: hidden base64 anchor — `<!--tessl-optimized-b64:path:b64-->`
  const b64Regex = /<!--tessl-optimized-b64:(.+?):([A-Za-z0-9+/=]+)-->/g;
  let match: RegExpExecArray | null;
  while ((match = b64Regex.exec(body)) !== null) {
    const skillPath = match[1]!;
    try {
      const content = Buffer.from(match[2]!, 'base64').toString('utf-8');
      results.set(skillPath, content);
    } catch {
      // Skip malformed entries — caller will surface "no optimized content"
    }
  }

  // Legacy format: visible markdown code block between paired HTML comments.
  // Kept for backward compatibility with comments produced before the b64 switch.
  const legacyRegex = /<!-- tessl-optimized:(.+?) -->\n```markdown\n([\s\S]*?)\n```\n<!-- \/tessl-optimized:\1 -->/g;
  while ((match = legacyRegex.exec(body)) !== null) {
    const skillPath = match[1]!;
    if (results.has(skillPath)) continue; // Prefer the new format
    const content = match[2]!.replace(/` ` `/g, '```');
    results.set(skillPath, content);
  }

  return results;
}

async function postReply(
  octokit: ReturnType<typeof github.getOctokit>,
  context: typeof github.context,
  prNumber: number,
  body: string,
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
  } catch {
    // Non-critical — log but don't fail
    console.warn('Failed to post reply comment');
  }
}

/** Author associations allowed to trigger /apply-optimize. */
const ALLOWED_ASSOCIATIONS = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

async function apply(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const context = github.context;
  const octokit = github.getOctokit(token);

  // Get PR number from the issue_comment event
  const prNumber = context.payload.issue?.number;
  if (!prNumber) {
    throw new Error('No PR number found in event payload');
  }

  // Defense in depth: refuse if the trigger commenter isn't a collaborator.
  // Workflows should also gate this via `if: contains(...)` but we check here
  // too so a misconfigured workflow can't be used to commit attacker content.
  const triggerComment = context.payload.comment as
    | { author_association?: string; id?: number; body?: string }
    | undefined;
  const triggerAssoc = triggerComment?.author_association;
  if (!triggerAssoc || !ALLOWED_ASSOCIATIONS.has(triggerAssoc)) {
    await postReply(
      octokit,
      context,
      prNumber,
      `⚠️ \`/apply-optimize\` is restricted to repo collaborators (got author_association \`${triggerAssoc ?? 'NONE'}\`).`,
    );
    return;
  }

  // Acknowledge the trigger immediately with 👀
  const triggerCommentId = triggerComment?.id;
  if (triggerCommentId) {
    try {
      await octokit.rest.reactions.createForIssueComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: triggerCommentId,
        content: 'eyes',
      });
    } catch {
      // Non-critical
    }
  }

  // Verify this is a PR (not a regular issue)
  const { data: pr } = await octokit.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber,
  });

  const prBranch = pr.head.ref;
  console.log(`Applying optimization to PR #${prNumber} on branch ${prBranch}`);

  // Checkout the PR branch (issue_comment events check out the default branch)
  const gitFetch = Bun.spawnSync(['git', 'fetch', 'origin', prBranch]);
  if (gitFetch.exitCode !== 0) {
    throw new Error(`git fetch failed: ${gitFetch.stderr.toString()}`);
  }
  const gitCheckout = Bun.spawnSync(['git', 'checkout', prBranch]);
  if (gitCheckout.exitCode !== 0) {
    throw new Error(`git checkout failed: ${gitCheckout.stderr.toString()}`);
  }

  // Find the skill-review bot comment
  let botComment: { id: number; body?: string | null } | undefined;
  let page = 1;

  while (!botComment) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
      page,
    });

    // SECURITY: only trust comments authored by a Bot (e.g. github-actions[bot]).
    // Without this filter, any human commenter could spoof the marker and have
    // their base64 anchor extracted and committed to the PR branch.
    botComment = comments.find(
      (c) => c.user?.type === 'Bot' && c.body?.includes(COMMENT_MARKER),
    );
    if (comments.length < 100) break;
    page++;
  }

  if (!botComment?.body) {
    core.setFailed('No skill review comment found on this PR. Run the review first.');
    return;
  }

  // Extract optimized content
  const optimized = extractOptimizedContent(botComment.body);
  if (optimized.size === 0) {
    core.setFailed('No optimized content found in the review comment.');
    return;
  }

  // Optional skill path argument: `/apply-optimize path/to/SKILL.md` applies
  // only that one. Bare `/apply-optimize` keeps the original "apply all" behavior.
  const triggerBody = (context.payload.comment?.body as string | undefined) ?? '';
  const requestedPath = parseRequestedPath(triggerBody);

  let toApply = optimized;
  if (requestedPath) {
    const matched = findOptimizedEntry(optimized, requestedPath);
    if (!matched) {
      const available = [...optimized.keys()]
        .map((k) => `\`/apply-optimize ${k}\``)
        .join('\n- ');
      await postReply(
        octokit,
        context,
        prNumber,
        `⚠️ No optimization found for \`${requestedPath}\`.\n\nAvailable:\n- ${available}\n\nOr run \`/apply-optimize\` to apply all.`,
      );
      return;
    }
    // Use the canonical (bot-stored) key so the file write hits the right
    // path on case-sensitive filesystems even if the user wrote a typo.
    toApply = new Map([[matched.key, matched.content]]);
  }

  console.log(`Applying ${toApply.size} of ${optimized.size} optimized file(s): ${[...toApply.keys()].join(', ')}`);

  // Write each optimized file (validate paths to prevent traversal)
  const cwd = process.cwd();
  const cwdWithSep = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  for (const [filePath, content] of toApply) {
    const resolved = path.resolve(cwd, filePath);
    // Strict prefix check: `resolved.startsWith(cwd)` alone would let
    // `/x/repo-evil/SKILL.md` escape from `cwd = /x/repo`.
    if (resolved !== cwd && !resolved.startsWith(cwdWithSep)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    if (!filePath.endsWith('/SKILL.md') && !filePath.endsWith('SKILL.md')) {
      throw new Error(`Unexpected file path (expected SKILL.md): ${filePath}`);
    }
    await Bun.write(resolved, content);
    console.log(`Wrote optimized content to ${resolved}`);
  }

  // Configure git for CI
  Bun.spawnSync(['git', 'config', 'user.name', 'tessl-skill-review[bot]']);
  Bun.spawnSync(['git', 'config', 'user.email', 'skill-review[bot]@users.noreply.github.com']);

  // Commit and push
  const gitAdd = Bun.spawnSync(['git', 'add', ...toApply.keys()]);
  if (gitAdd.exitCode !== 0) {
    throw new Error(`git add failed: ${gitAdd.stderr.toString()}`);
  }

  const gitCommit = Bun.spawnSync([
    'git', 'commit', '-m', 'Apply optimized SKILL.md from Tessl review',
  ]);
  if (gitCommit.exitCode !== 0) {
    const stdout = gitCommit.stdout.toString();
    const stderr = gitCommit.stderr.toString();
    if (stdout.includes('nothing to commit') || stderr.includes('nothing to commit')) {
      console.log('No changes to commit (files already up to date).');
      await postReply(octokit, context, prNumber, '⚠️ No changes to apply — files are already up to date.');
      return;
    }
    throw new Error(`git commit failed: ${stderr || stdout}`);
  }

  const gitPush = Bun.spawnSync(['git', 'push', 'origin', `HEAD:${prBranch}`]);
  if (gitPush.exitCode !== 0) {
    throw new Error(`git push failed: ${gitPush.stderr.toString()}`);
  }

  // Get the commit SHA for the confirmation message
  const gitRev = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  const commitSha = gitRev.stdout.toString().trim().slice(0, 7);

  console.log('Optimization applied and pushed successfully.');

  // Post confirmation comment with key improvements summary
  const files = [...toApply.keys()].map(f => `\`${f}\``).join(', ');
  const improvements = extractKeyImprovements(botComment.body);
  let confirmBody = `✅ Applied optimized ${files} (${commitSha}).`;
  if (improvements.length > 0) {
    confirmBody += '\n\n**What changed:**';
    for (const item of improvements.slice(0, 3)) {
      confirmBody += `\n- ${item}`;
    }
  }
  await postReply(octokit, context, prNumber, confirmBody);

  try {
    await octokit.rest.reactions.createForIssueComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: context.payload.comment?.id as number,
      content: 'rocket',
    });
  } catch {
    // Reaction is nice-to-have, don't fail on it
  }
}

if (import.meta.main) {
  apply().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
