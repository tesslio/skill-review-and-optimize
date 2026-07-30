import { dirname } from 'node:path';
import * as github from '@actions/github';
import { effectivePass } from './skill-review.ts';
import type { SkillReviewResult } from './skill-review.ts';
import { encodeOptimizedAnchor } from './inline-suggestions.ts';

export const COMMENT_MARKER = '<!-- tessl-skill-review -->';

/** Escape text for safe inclusion in markdown code fences */
function escapeForCodeFence(text: string): string {
  return text.replace(/```/g, '` ` `');
}

/** Escape text for safe inclusion in inline markdown */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>~]/g, '\\$&');
}

const TESSL_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 21 24"><path fill="%23f8f8f8" d="M5.8 10.47c0-.21.22-.35.4-.24l3.75 2.2v4.95c0 .87.92 1.4 1.65.96l3.6-2.17v5.41l-3.6 2.12c-.69.4-1.52.4-2.2 0l-3.6-2.12zM21 16.9c0 .8-.42 1.53-1.1 1.93l-3.6 2.12V15.5l4.7-2.85zM4.7 15.4v5.53l-3.6-2.12A2.2 2.2 0 0 1 0 16.89v-4.24zM19.9 5.19c.68.4 1.1 1.13 1.1 1.93v4.23l-9.54 5.79c-.19.1-.42-.03-.42-.24v-4.46l4.57-2.7a.84.84 0 0 0 0-1.44l-4.07-2.44 4.75-2.8zm-5.65 3.59c.19.1.19.38 0 .48l-3.75 2.2-4.56-2.68a.82.82 0 0 0-1.24.73v4.61L0 11.36V7.12c0-.8.42-1.54 1.1-1.93l3.6-2.13zM9.4.3c.68-.4 1.51-.4 2.2 0l3.6 2.12-4.75 2.79L5.8 2.42z"/></svg>`;

function pullRequestFilesUrl(): string {
  const ctx = github.context;
  const prNumber = ctx.payload.pull_request?.number;
  return `https://github.com/${ctx.repo.owner}/${ctx.repo.repo}/pull/${prNumber}/files`;
}

function scoreBadge(score: number, label = 'Tessl Review Score'): string {
  const color =
    score >= 80 ? 'brightgreen' : score >= 60 ? 'yellow' : score >= 40 ? 'orange' : 'red';
  const logoParam = encodeURIComponent(TESSL_LOGO_SVG);
  const encodedLabel = encodeURIComponent(label).replace(/%20/g, '%20');
  return `![score](https://img.shields.io/badge/${encodedLabel}-${score}%25-${color}?logo=${logoParam})`;
}

export interface OptimizeContext {
  skipped: boolean;
  inlineSuggestionsEnabled?: boolean;
}

/**
 * What a reader should see before expanding anything: the judge's one-line
 * assessment, then every validation check that didn't pass. The collapsed
 * details carry the per-dimension table and the passed-check tally.
 */
function reviewHighlights(result: SkillReviewResult): string {
  const parts: string[] = [];
  if (result.overallAssessment) {
    parts.push(`_${result.overallAssessment}_`);
  }
  if (result.validationIssues && result.validationIssues.length > 0) {
    parts.push(
      ['**Validation**', '', ...result.validationIssues.map((i) => `- ${i}`)].join('\n'),
    );
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n\n` : '';
}

function fileList(files: string[]): string {
  return files.map((f) => `\`${f}\``).join(', ');
}

/** The command that applies a whole bundle, for the cases this action can't. */
function fixCommand(skillPath: string): string {
  return `\`tessl review fix ${dirname(skillPath)}\``;
}

/**
 * Note the files a fix changed alongside SKILL.md. Only SKILL.md travels
 * through the diff, the inline suggestions, and `/apply-optimize`, so accepting
 * a suggestion that leans on these files leaves them behind.
 */
function bundleFilesNote(files: string[], skillPath: string): string {
  return (
    `> ℹ️ The fix also changed ${fileList(files)} in this skill bundle. ` +
    `Only \`SKILL.md\` is applied here — run ${fixCommand(skillPath)} locally to take the rest.\n\n`
  );
}

function formatComment(
  results: SkillReviewResult[],
  threshold: number,
  optimizeContext?: OptimizeContext,
): string {
  const optimizedCount = results.filter((r) => r.optimize?.optimized).length;
  const sections = results.map((result) => {
    // Emoji reflects the *effective* pass status — i.e. uses the after-score
    // when optimize ran. Keeps the comment in sync with the threshold check.
    const passes = effectivePass(result, threshold);
    const emoji =
      result.error
        ? ' ⚠️'
        : threshold > 0 && passes
          ? ' ✅'
          : threshold > 0 && !passes
            ? ' ❌'
            : '';

    let body: string;
    if (result.error) {
      body = `\n> ⚠️ **Error:** ${escapeMarkdown(result.error)}\n`;
      if (result.output) {
        body += `\n<details>\n<summary>Output</summary>\n\n\`\`\`\n${escapeForCodeFence(result.output)}\n\`\`\`\n\n</details>\n`;
      }
    } else if (result.optimize?.optimized) {
      const before = result.optimize.beforeScore;
      const after = result.optimize.afterScore;
      const beforeBadge = scoreBadge(before, 'before');
      const afterBadge = scoreBadge(after, 'after');
      body = `${beforeBadge} → ${afterBadge}\n\n`;
      body += `🎯 **An opportunity to take this skill from ${before}% to ${after}%.** Have a look at the suggestions below.\n\n`;
      body += reviewHighlights(result);

      const otherFiles = result.optimize.bundleFilesChanged;
      if (otherFiles && otherFiles.length > 0) {
        body += bundleFilesNote(otherFiles, result.skillPath);
      }

      // Single source of truth for per-dimension feedback: the review table
      // (with the Suggestion column intact).
      body += `<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n\n`;

      if (optimizeContext?.inlineSuggestionsEnabled) {
        const filesUrl = pullRequestFilesUrl();
        body += `### 👉 [Review suggestions on the Files changed tab](${filesUrl})\n\n`;
        if (optimizedCount > 1) {
          body += `Accept individually with **Commit suggestion**, batch several with **Add suggestion to batch**, or comment \`/apply-optimize\` to accept all changes across every skill.\n`;
          body += `\nOr comment \`/apply-optimize ${result.skillPath}\` to apply just this skill.\n`;
        } else {
          // Single-skill: include the path so the command is copy-pasteable.
          body += `Accept individually with **Commit suggestion**, batch several with **Add suggestion to batch**, or comment \`/apply-optimize ${result.skillPath}\` to accept all changes for this skill.\n`;
        }
      } else if (optimizedCount > 1) {
        body += `Comment \`/apply-optimize ${result.skillPath}\` to apply this skill, or \`/apply-optimize\` to apply all.\n`;
      } else {
        body += `Comment \`/apply-optimize ${result.skillPath}\` to apply this change directly to the PR.\n`;
      }

      // Hidden anchor so /apply-optimize can still extract the full optimized
      // content from the comment body without cluttering the rendered view.
      body += `\n${encodeOptimizedAnchor(result.skillPath, result.optimize.optimizedContent ?? '')}\n`;
    } else if (
      result.optimize &&
      !result.optimize.error &&
      result.optimize.afterScore > result.optimize.beforeScore
    ) {
      // The fix scored higher without touching SKILL.md, so there is nothing
      // for the diff, the suggestions, or /apply-optimize to carry. Report the
      // score it reached and where the change would have to land.
      const badge = result.score >= 0 ? ` ${scoreBadge(result.score)}${emoji}` : '';
      const files = result.optimize.bundleFilesChanged ?? [];
      const target = files.length > 0 ? fileList(files) : 'files outside `SKILL.md`';
      body = `${badge}\n\n`;
      body += `🔧 **\`tessl review fix\` reaches ${result.optimize.afterScore}%** by changing ${target}, which this action cannot apply for you. Run ${fixCommand(result.skillPath)} locally to take it.\n\n`;
      body += reviewHighlights(result);
      body += `<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n`;
    } else if (result.optimize && !result.optimize.error) {
      // Optimize ran but didn't produce a recommendable improvement — either
      // it left the file alone, or it tried and the result regressed. In both
      // cases we keep the user's version and report it as good-as-is.
      const badge = result.score >= 0 ? ` ${scoreBadge(result.score)}${emoji}` : '';
      body = `${badge} *(no further improvements available — keeping your version)*\n\n${reviewHighlights(result)}<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n`;
    } else {
      // Standard review-only display
      const badge = result.score >= 0 ? ` ${scoreBadge(result.score)}${emoji}` : '';
      body = `${badge}\n\n${reviewHighlights(result)}<details>\n<summary>Review Details</summary>\n\n${result.output}\n\n</details>\n`;
    }

    return `### \`${result.skillPath}\`\n${body}`;
  });

  const footerParts = [
    '---',
  ];

  // Add optimize CTA if optimize was requested but no token
  if (optimizeContext?.skipped) {
    footerParts.push(
      '',
      '**Optional:** add a [Tessl API token](https://tessl.io/account/api-keys?utm_source=tessl_github&utm_medium=github&utm_campaign=q1_maintainers_26) as `TESSL_API_TOKEN` in your repo secrets. The action will suggest an optimized version automatically in future PRs.',
    );
  }

  const footer = footerParts.join('\n');

  return `${COMMENT_MARKER}\n## 🔍 Tessl Skill Review\n\n${sections.join('\n---\n\n')}\n${footer}`;
}

export async function postOrUpdateComment(
  results: SkillReviewResult[],
  threshold: number,
  optimizeContext?: OptimizeContext,
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to post comments');
  }

  const context = github.context;
  if (!context.payload.pull_request) {
    throw new Error('No pull request context found');
  }

  const octokit = github.getOctokit(token);
  const prNumber = context.payload.pull_request.number;
  const body = formatComment(results, threshold, optimizeContext);

  // Look for an existing comment from this action (paginate to find it)
  let existing: { id: number; body?: string | null } | undefined;
  let commentPage = 1;

  while (!existing) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      per_page: 100,
      page: commentPage,
    });

    existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
    if (comments.length < 100) break;
    commentPage++;
  }

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
    console.log(`Updated existing PR comment (id: ${existing.id})`);
  } else {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body,
    });
    console.log('Posted new PR comment');
  }
}
