import { dirname, join, resolve } from 'node:path';

/** Prefer the CLI installed by setup-tessl, falling back to the package binary for local runs. */
function tesslBin(): string {
  const envBin = process.env.TESSL_BIN?.trim();
  return envBin && envBin.length > 0
    ? envBin
    : resolve(import.meta.dir, '..', 'node_modules', '.bin', 'tessl');
}

/**
 * Run a single sequential `tessl --version` to force the binary's first-run
 * verification/extraction to complete before any parallel review/optimize
 * calls. Mitigates an upstream tessl CLI race where two parallel invocations
 * both decide the binary is "corrupt" on first cold start, delete it, and
 * each fail with ENOENT/ETXTBSY.
 *
 * Best-effort: we swallow errors here so a transient warmup failure doesn't
 * block the actual review pass.
 */
export async function warmupTessl(): Promise<void> {
  try {
    const proc = Bun.spawn([tesslBin(), '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  } catch {
    // Ignore — main.ts will surface any real failure on the first review.
  }
}

/** Format a score dimension as a table row with visual bar */
function scoreBar(score: number, max = 3): string {
  const filled = '█'.repeat(score);
  const empty = '░'.repeat(max - score);
  return `${filled}${empty} ${score}/${max}`;
}

/** Remove filler words/phrases to keep table cells tight */
function trimFiller(text: string): string {
  return text
    // Multi-word filler phrases (order matters: longest first)
    .replace(/\b(in order to|the fact that|it is worth noting that|it should be noted that|at a high level|for the most part|almost entirely|more or less)\b/gi, '')
    // Single-word fillers
    .replace(/\b(however|therefore|additionally|furthermore|essentially|basically|actually|really|very|quite|rather|somewhat|reasonably|relatively|generally|certainly|obviously|simply|merely|just|also|perhaps|indeed|notably)\b/gi, '')
    // Hedging/padding phrases
    .replace(/\b(it seems that|this means that|the skill is|the content is|this is because|there are|it is|it has)\b/gi, '')
    // Leading conjunctions
    .replace(/^(but|and|so|yet|though|although)\b\s*/i, '')
    // Clean up artifacts: double spaces, leading/trailing punctuation
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,;]\s*/, '')
    .replace(/\s*[,;]\s*$/, '')
    .trim();
}

/**
 * Format the evaluation object into readable markdown.
 * Handles the known shape: { scores, overall_assessment, suggestions }
 * Falls back to JSON for unknown shapes.
 */
function formatEvaluation(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) {
    return JSON.stringify(value, null, 2);
  }

  const eval_ = value as Record<string, unknown>;
  const parts: string[] = [];

  // Format scores + suggestions as a single table
  if (eval_.scores && typeof eval_.scores === 'object') {
    const scores = eval_.scores as Record<
      string,
      { score?: number; reasoning?: string }
    >;
    const suggestions = Array.isArray(eval_.suggestions) ? eval_.suggestions as string[] : [];
    const entries = Object.entries(scores);

    parts.push('| Dimension | Score | Detail | Suggestion |');
    parts.push('|-----------|-------|--------|------------|');
    for (let i = 0; i < entries.length; i++) {
      const [key, val] = entries[i]!;
      const label = key.replace(/_/g, ' ');
      const bar = typeof val.score === 'number' ? scoreBar(val.score) : '—';
      const reasoning = trimFiller(val.reasoning ?? '').replace(/\|/g, '\\|');
      const suggestion = trimFiller(suggestions[i] ?? '').replace(/\|/g, '\\|');
      parts.push(`| **${label}** | ${bar} | ${reasoning} | ${suggestion} |`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(value, null, 2);
}

/**
 * Extract the first complete top-level JSON object from a string
 * that may contain non-JSON text before/after it.
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export interface OptimizeResult {
  optimized: boolean;
  beforeScore: number;
  afterScore: number;
  optimizedContent?: string;
  /** Pre-optimize file contents — used for rendering a diff in the PR comment. */
  originalContent?: string;
  error?: string;
}

export interface SkillReviewResult {
  skillPath: string;
  passed: boolean;
  score: number;
  output: string;
  error?: string;
  optimize?: OptimizeResult;
  /**
   * Required changes surfaced prominently (not hidden in a <details>):
   * failed/warning validation checks plus the content judge's suggestions.
   */
  requiredChanges?: string[];
  /** One-line summary from the content judge, if present. */
  overallAssessment?: string;
}

interface Evaluation {
  scores?: Record<string, { score?: number; reasoning?: string }>;
  suggestions?: string[];
  overall_assessment?: string;
}

interface ReviewRunJson {
  review?: { reviewScore?: number };
  validation?: {
    overallPassed?: boolean;
    errorCount?: number;
    warningCount?: number;
    checks?: Array<{ name?: string; status?: string; message?: string }>;
  };
  judges?: {
    content?: { normalizedScore?: number; evaluation?: unknown };
    description?: { normalizedScore?: number; evaluation?: unknown };
  };
}

/** Score from the new `tessl review run --json` shape (0-100). */
function reviewScoreFrom(parsed: ReviewRunJson): number {
  return typeof parsed.review?.reviewScore === 'number'
    ? parsed.review.reviewScore
    : Math.round((parsed.judges?.content?.normalizedScore ?? 0) * 100);
}

/**
 * Render validation checks: the failing/warning messages (for prominent
 * display) and a markdown block listing anything that didn't pass.
 */
function formatValidation(
  validation: ReviewRunJson['validation'],
): { failures: string[]; markdown: string } {
  const checks = validation?.checks ?? [];
  if (checks.length === 0) return { failures: [], markdown: '' };

  const notPassed = checks.filter((c) => c.status && c.status !== 'passed');
  const failures = notPassed.map((c) => c.message ?? c.name ?? 'validation issue');

  const parts: string[] = ['### Validation Checks', ''];
  if (notPassed.length === 0) {
    parts.push(`✅ All ${checks.length} checks passed.`);
  } else {
    for (const c of notPassed) {
      const icon = c.status === 'warning' ? '⚠️' : '❌';
      parts.push(`- ${icon} **${c.name}** — ${c.message ?? ''}`);
    }
  }
  return { failures, markdown: parts.join('\n') };
}

export function isAuthErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /requires you to be logged in|run tessl login|401 unauthorized|authentication required|not authenticated/i.test(
    message,
  );
}

/**
 * The threshold-comparison score for a skill. When optimize produced a
 * recommendable improvement we use the after-score (the achievable
 * post-optimize score); otherwise the original review score. A regressing
 * optimize run is treated as "keep original", so its lower after-score must
 * not drag the threshold check below the original.
 */
export function effectiveScore(result: SkillReviewResult): number {
  if (result.optimize?.optimized) {
    return result.optimize.afterScore;
  }
  return result.score;
}

/**
 * Whether a skill passes the threshold check. Treats optimization as the
 * achievable target: a skill the optimizer can lift above the threshold is
 * considered passing, because the user has a one-click path to merge via
 * `/apply-optimize`. Avoids the contradictory UX where the comment shows a
 * 85% optimized score but the check still blocks at the 50% before-score.
 */
export function effectivePass(
  result: SkillReviewResult,
  threshold: number,
): boolean {
  if (isAuthErrorMessage(result.error)) return false;
  if (threshold === 0) return true;
  if (result.error) return false;
  return effectiveScore(result) >= threshold;
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
  workspace: string,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  // Tessl Review (replaces the deprecated `tessl skill review`). Single
  // blocking call; a workspace is now required.
  const proc = Bun.spawn(
    [tesslBin(), 'review', 'run', 'quality', '--json', '--workspace', workspace, skillDir],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const error = stderr || stdout || `Process exited with code ${exitCode}`;
    console.warn(
      `tessl review run failed for ${skillFilePath} (exit code ${exitCode}): ${error}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0 && !isAuthErrorMessage(error),
      score: -1,
      output: '',
      error,
    };
  }

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    console.warn(`No JSON found in review output for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: stdout,
      error: 'Could not parse review output',
    };
  }

  let parsed: ReviewRunJson;
  try {
    parsed = JSON.parse(jsonStr) as ReviewRunJson;
  } catch {
    console.warn(`Failed to parse review JSON for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: jsonStr,
      error: 'Failed to parse JSON output',
    };
  }

  const score = reviewScoreFrom(parsed);

  const contentEval = parsed.judges?.content?.evaluation as Evaluation | undefined;
  const { failures: validationFailures, markdown: validationMarkdown } =
    formatValidation(parsed.validation);

  const suggestions =
    contentEval && Array.isArray(contentEval.suggestions)
      ? contentEval.suggestions.filter((s): s is string => typeof s === 'string')
      : [];
  const requiredChanges = [...validationFailures, ...suggestions];
  const overallAssessment =
    contentEval && typeof contentEval.overall_assessment === 'string'
      ? contentEval.overall_assessment
      : undefined;

  const outputParts: string[] = [];
  if (validationMarkdown) outputParts.push(validationMarkdown);
  if (parsed.judges?.content?.evaluation) {
    outputParts.push(
      '### Review Details\n\n' + formatEvaluation(parsed.judges.content.evaluation),
    );
  }
  if (parsed.judges?.description?.evaluation) {
    outputParts.push(
      '### Description Review\n\n' +
        formatEvaluation(parsed.judges.description.evaluation),
    );
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
    requiredChanges: requiredChanges.length > 0 ? requiredChanges : undefined,
    overallAssessment,
  };
}

export function parseOptimizeIterations(value: string | undefined): number {
  const num = Number(value ?? '3');
  if (!Number.isInteger(num) || num < 1 || num > 10) {
    throw new Error(
      `Invalid optimize-iterations: ${value}. Must be an integer between 1 and 10.`,
    );
  }
  return num;
}

export async function runSkillOptimize(
  skillFilePath: string,
  beforeScore: number,
  maxIterations: number,
  workspace: string,
): Promise<OptimizeResult> {
  const skillDir = dirname(skillFilePath);

  // Read original content to detect changes and restore afterward
  const originalContent = await Bun.file(skillFilePath).text();

  // Tessl Review's `review fix` is the automated review-and-fix loop that
  // replaces the old `skill review --optimize`. With --yes it applies the
  // improved skill to disk, which we detect and (in suggestion-only mode)
  // revert below after capturing an after-score.
  const proc = Bun.spawn(
    [
      tesslBin(), 'review', 'fix',
      '--workspace', workspace,
      '--yes',
      '--max-iterations', String(maxIterations),
      skillDir,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Log stderr for debugging (strip any token-like strings)
    const safeStderr = stderr.replace(/[A-Za-z0-9_-]{20,}/g, '***');
    console.warn(`tessl review fix stderr: ${safeStderr}`);
    // Restore original in case of partial write
    await Bun.write(skillFilePath, originalContent);
    // Do not include raw stderr in error — it may contain auth token from tessl CLI
    return {
      optimized: false,
      beforeScore,
      afterScore: beforeScore,
      error: `Optimize exited with code ${exitCode}. Check action logs for details.`,
    };
  }

  // Read potentially modified content
  const newContent = await Bun.file(skillFilePath).text();
  const contentChanged = newContent !== originalContent;

  // Get after-score by running a fresh review of the improved skill.
  let afterScore = beforeScore;
  if (contentChanged) {
    const reviewProc = Bun.spawn(
      [tesslBin(), 'review', 'run', 'quality', '--json', '--workspace', workspace, skillDir],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const reviewStdout = await new Response(reviewProc.stdout).text();
    await reviewProc.exited;
    const jsonStr = extractJson(reviewStdout);
    if (jsonStr) {
      try {
        afterScore = reviewScoreFrom(JSON.parse(jsonStr) as ReviewRunJson);
      } catch {
        // Score parsing failed; keep beforeScore
      }
    }
  }

  // Restore original file (suggestion-only mode)
  await Bun.write(skillFilePath, originalContent);

  // Only treat the run as "optimized" when it produced a score improvement.
  // A run that changes content but doesn't beat the before-score is treated
  // as no-improvement-available downstream: we keep the user's version, omit
  // the diff/inline-suggestions, and the comment falls into the affirming
  // "no further improvements available" branch.
  const optimized = contentChanged && afterScore > beforeScore;

  return {
    optimized,
    beforeScore,
    afterScore,
    optimizedContent: optimized ? newContent : undefined,
    originalContent: optimized ? originalContent : undefined,
  };
}
