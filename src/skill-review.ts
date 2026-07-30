import { readdir, rm, stat } from 'node:fs/promises';
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
  // blocking call; a workspace is now required. `--threshold 0` is the CLI's
  // explicit "never fail" value: without it, `review run quality` exits
  // non-zero whenever `validation.overallPassed` is false, and we'd bail on the
  // non-zero exit below — before parsing the JSON the CLI already printed —
  // rendering a validation-failing skill as ERROR instead of a score plus its
  // required changes. Gating stays in the action (see `effectivePass`), so the
  // CLI itself must never gate.
  const proc = Bun.spawn(
    [tesslBin(), 'review', 'run', 'quality', '--json', '--workspace', workspace, '--threshold', '0', skillDir],
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

/**
 * Snapshot every file under a skill bundle directory as `relpath -> bytes`.
 *
 * `tessl review fix` operates on the whole bundle — it can add, edit, or delete
 * files anywhere in the skill directory (references included), not just
 * SKILL.md — so a single-file snapshot cannot fully revert it. Returns `null`
 * if the directory can't be enumerated; callers fall back to single-file
 * handling.
 */
async function snapshotBundle(
  dir: string,
): Promise<Map<string, Uint8Array> | null> {
  try {
    const snapshot = new Map<string, Uint8Array>();
    const entries = await readdir(dir, { recursive: true });
    for (const rel of entries) {
      const info = await stat(join(dir, rel)).catch(() => null);
      if (!info?.isFile()) continue;
      snapshot.set(rel, new Uint8Array(await Bun.file(join(dir, rel)).arrayBuffer()));
    }
    return snapshot;
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Whether any file under `dir` differs from the snapshot (added, removed, or modified). */
async function bundleChanged(
  dir: string,
  snapshot: Map<string, Uint8Array>,
): Promise<boolean> {
  const current = await snapshotBundle(dir);
  if (!current) return false;
  if (current.size !== snapshot.size) return true;
  for (const [rel, bytes] of current) {
    const before = snapshot.get(rel);
    if (!before || !bytesEqual(before, bytes)) return true;
  }
  return false;
}

/**
 * Restore a skill bundle to a prior snapshot: remove any file the fix added,
 * then rewrite every snapshotted file (covering both edits and deletions).
 */
async function restoreBundle(
  dir: string,
  snapshot: Map<string, Uint8Array>,
): Promise<void> {
  const current = await readdir(dir, { recursive: true }).catch(
    () => [] as string[],
  );
  for (const rel of current) {
    const info = await stat(join(dir, rel)).catch(() => null);
    if (info?.isFile() && !snapshot.has(rel)) {
      await rm(join(dir, rel), { force: true });
    }
  }
  for (const [rel, bytes] of snapshot) {
    await Bun.write(join(dir, rel), bytes);
  }
}

export async function runSkillOptimize(
  skillFilePath: string,
  beforeScore: number,
  maxIterations: number,
  workspace: string,
): Promise<OptimizeResult> {
  const skillDir = dirname(skillFilePath);

  // SKILL.md is the basis for the PR diff, inline suggestions, and
  // /apply-optimize (all SKILL.md-centric), so read it up front.
  const originalContent = await Bun.file(skillFilePath).text();

  // Snapshot the whole bundle so a bundle-wide `review fix` can be fully
  // reverted (not just SKILL.md) and improvements that live outside SKILL.md
  // are still detected. Falls back to single-file handling if the directory
  // can't be enumerated.
  const bundle = await snapshotBundle(skillDir);
  const restore = async () => {
    if (bundle) await restoreBundle(skillDir, bundle);
    else await Bun.write(skillFilePath, originalContent);
  };

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
    // Restore in case of partial write
    await restore();
    // Do not include raw stderr in error — it may contain auth token from tessl CLI
    return {
      optimized: false,
      beforeScore,
      afterScore: beforeScore,
      error: `Optimize exited with code ${exitCode}. Check action logs for details.`,
    };
  }

  // Read potentially modified SKILL.md (basis for the diff/apply path).
  const newContent = await Bun.file(skillFilePath).text();
  const skillMdChanged = newContent !== originalContent;

  // A fix can improve the skill via files other than SKILL.md; detect changes
  // across the whole bundle so the after-score reflects them (a single-file
  // check would misread such a run as "no change" and keep a stale score).
  const contentChanged = bundle
    ? await bundleChanged(skillDir, bundle)
    : skillMdChanged;

  // Get after-score by running a fresh review of the improved skill.
  let afterScore = beforeScore;
  if (contentChanged) {
    // `--threshold 0` for parity with runSkillReview: never let the CLI gate;
    // the after-score is read purely from the JSON payload.
    const reviewProc = Bun.spawn(
      [tesslBin(), 'review', 'run', 'quality', '--json', '--workspace', workspace, '--threshold', '0', skillDir],
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

  // Restore the bundle (suggestion-only mode).
  await restore();

  // Only treat the run as "optimized" when it produced a score improvement
  // that lands in SKILL.md. The diff, inline suggestions, and /apply-optimize
  // all operate on SKILL.md, so a run that raises the score only via other
  // bundle files (e.g. references) is scored but not one-click-applyable
  // through this action — a known v2 limitation. A change that doesn't beat
  // the before-score is likewise treated as no-improvement-available: we keep
  // the user's version and the comment falls into the affirming
  // "no further improvements available" branch.
  const optimized = skillMdChanged && afterScore > beforeScore;

  return {
    optimized,
    beforeScore,
    afterScore,
    optimizedContent: optimized ? newContent : undefined,
    originalContent: optimized ? originalContent : undefined,
  };
}
