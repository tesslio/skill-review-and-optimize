import { readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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

/** One judge's verdict: a score and reasoning per rubric dimension, plus prose. */
interface Evaluation {
  scores?: Record<string, { score?: number; reasoning?: string }>;
  suggestions?: string[];
  overall_assessment?: string;
}

interface JudgeResult {
  normalizedScore?: number;
  /** The rubric's scoring scale — `max` is the denominator for every dimension score. */
  scale?: { min?: number; max?: number };
  evaluation?: Evaluation | string;
}

/** The `tessl review run quality --json` payload. */
interface ReviewRunJson {
  review?: { reviewScore?: number };
  validation?: {
    overallPassed?: boolean;
    errorCount?: number;
    warningCount?: number;
    checks?: Array<{ name?: string; status?: string; message?: string }>;
  };
  /** Keyed by judge id: `content` and `description` for the skill rubrics. */
  judges?: Record<string, JudgeResult | undefined>;
}

/**
 * Narrowest denominator to assume for a judge that reports dimension scores
 * without a `scale`. Those payloads come from the older 1-3 rubric.
 */
const LEGACY_SCALE_MAX = 3;

/**
 * The denominator to render a judge's dimension scores against: its declared
 * rubric scale, or — for a payload that omits one — the highest score it
 * reported, so a rubric wider than 1-3 isn't rendered as full marks.
 */
function scaleMaxOf(judge: JudgeResult, evaluation: Evaluation): number {
  if (judge.scale?.max !== undefined) return judge.scale.max;
  const scores = Object.values(evaluation.scores ?? {}).map((s) => s.score ?? 0);
  return Math.max(LEGACY_SCALE_MAX, ...scores);
}

/**
 * Format one dimension's score as a bar. `max` is the rubric's top score, so a
 * 1-5 rubric renders `████░ 4/5`. Both counts are clamped to the scale, since
 * `repeat` rejects a negative count.
 */
function scoreBar(score: number, max: number): string {
  const filled = '█'.repeat(Math.max(0, Math.min(score, max)));
  const empty = '░'.repeat(Math.max(0, max - score));
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
 * Render a judge's evaluation as one table row per rubric dimension, pairing
 * each dimension with the suggestion at the same index. Empty when the judge
 * reported no evaluation; falls back to JSON for one that carries no scores.
 */
function formatEvaluation(judge: JudgeResult | undefined): string {
  const evaluation = judge?.evaluation;
  if (judge === undefined || evaluation === undefined) return '';
  if (typeof evaluation === 'string') return evaluation;

  const scores = evaluation.scores;
  if (!scores) return JSON.stringify(evaluation, null, 2);

  const scaleMax = scaleMaxOf(judge, evaluation);
  const suggestions = evaluation.suggestions ?? [];
  const entries = Object.entries(scores);
  const parts = [
    '| Dimension | Score | Detail | Suggestion |',
    '|-----------|-------|--------|------------|',
  ];
  for (let i = 0; i < entries.length; i++) {
    const [key, val] = entries[i]!;
    const label = key.replace(/_/g, ' ');
    const bar = typeof val.score === 'number' ? scoreBar(val.score, scaleMax) : '—';
    const reasoning = trimFiller(val.reasoning ?? '').replace(/\|/g, '\\|');
    const suggestion = trimFiller(suggestions[i] ?? '').replace(/\|/g, '\\|');
    parts.push(`| **${label}** | ${bar} | ${reasoning} | ${suggestion} |`);
  }
  return parts.join('\n');
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
  /**
   * Files the fix changed other than SKILL.md, relative to the skill directory.
   * The PR diff, the inline suggestions, and `/apply-optimize` all carry
   * SKILL.md alone, so these are reported to the author rather than applied.
   */
  bundleFilesChanged?: string[];
  error?: string;
}

export interface SkillReviewResult {
  skillPath: string;
  passed: boolean;
  score: number;
  output: string;
  error?: string;
  optimize?: OptimizeResult;
  /** Validation checks that didn't pass, rendered above the collapsed details. */
  validationIssues?: string[];
  /** The content judge's one-line summary, when the payload carries one. */
  overallAssessment?: string;
}

/** Review score on a 0-100 scale. */
function reviewScoreFrom(parsed: ReviewRunJson): number {
  return typeof parsed.review?.reviewScore === 'number'
    ? parsed.review.reviewScore
    : Math.round((parsed.judges?.content?.normalizedScore ?? 0) * 100);
}

/**
 * Split the validation checks into the ones worth showing up front — anything
 * that didn't pass, each with its own error/warning icon — and a one-line
 * tally for the collapsed details. Each check renders in exactly one of them.
 */
function formatValidation(
  validation: ReviewRunJson['validation'],
): { issues: string[]; markdown: string } {
  const checks = validation?.checks ?? [];
  if (checks.length === 0) return { issues: [], markdown: '' };

  const notPassed = checks.filter((c) => c.status && c.status !== 'passed');
  const issues = notPassed.map((c) => {
    const icon = c.status === 'warning' ? '⚠️' : '❌';
    const detail = c.message ? ` — ${c.message}` : '';
    return `${icon} **${c.name ?? 'validation issue'}**${detail}`;
  });

  const passedCount = checks.length - notPassed.length;
  const markdown = `### Validation Checks\n\n${passedCount}/${checks.length} checks passed.`;
  return { issues, markdown };
}

export function isAuthErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /requires you to be logged in|run tessl login|401 unauthorized|authentication required|not authenticated/i.test(
    message,
  );
}

/**
 * Whether the CLI failed because it could not settle on a workspace. It picks
 * one on its own only when the token can see exactly one, so a token with
 * access to several needs the `workspace` input.
 */
export function isWorkspaceErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /--workspace/.test(message);
}

/**
 * Whether a failure means no review ran at all, as opposed to a skill scoring
 * badly. `fail-threshold: 0` turns off score gating and must not turn these off
 * with it, or the check goes green having reviewed nothing.
 */
export function isSetupErrorMessage(message: string | undefined): boolean {
  return isAuthErrorMessage(message) || isWorkspaceErrorMessage(message);
}

/** Guidance appended to the CLI's own error, which names a flag rather than an input. */
const WORKSPACE_INPUT_HINT =
  'Set the workspace input to the Tessl workspace this repository reviews against. ' +
  'The token can see more than one, so the CLI cannot choose for you. ' +
  'Run tessl workspace list to see the names.';

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
  if (isSetupErrorMessage(result.error)) return false;
  if (threshold === 0) return true;
  if (result.error) return false;
  return effectiveScore(result) >= threshold;
}

/**
 * Argv for a single blocking quality review of `skillDir`.
 *
 * `--threshold 0` is the CLI's explicit "never fail" value. Without it the
 * command exits non-zero whenever `validation.overallPassed` is false, callers
 * bail on the exit code before parsing the JSON the CLI already printed, and a
 * skill with validation issues renders as an error instead of a score plus the
 * issues themselves. Gating belongs to the action (see `effectivePass`), so the
 * CLI must never gate.
 *
 * `--workspace` is omitted when the input is unset. The CLI then takes the
 * workspace from a `tessl.json` in the repository, or picks the only one the
 * token can see — a token with access to several is an error it can't resolve,
 * which `runSkillReview` turns into a request for the `workspace` input.
 */
function reviewRunArgs(skillDir: string, workspace: string | undefined): string[] {
  return [
    tesslBin(),
    'review',
    'run',
    'quality',
    '--json',
    ...(workspace ? ['--workspace', workspace] : []),
    '--threshold',
    '0',
    skillDir,
  ];
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
  workspace?: string,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  const proc = Bun.spawn(reviewRunArgs(skillDir, workspace), {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const cliError = stderr || stdout || `Process exited with code ${exitCode}`;
    // The CLI asks for its `--workspace` flag; the fix is this action's input.
    const error = isWorkspaceErrorMessage(cliError)
      ? `${cliError.trim()}\n\n${WORKSPACE_INPUT_HINT}`
      : cliError;
    console.warn(
      `tessl review run failed for ${skillFilePath} (exit code ${exitCode}): ${error}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0 && !isSetupErrorMessage(error),
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

  const content = parsed.judges?.content;
  const { issues: validationIssues, markdown: validationMarkdown } =
    formatValidation(parsed.validation);

  const contentEval = content?.evaluation;
  const overallAssessment =
    typeof contentEval === 'object' ? contentEval.overall_assessment : undefined;

  const outputParts: string[] = [];
  if (validationMarkdown) outputParts.push(validationMarkdown);

  const contentDetails = formatEvaluation(content);
  if (contentDetails) outputParts.push(`### Review Details\n\n${contentDetails}`);

  const descriptionDetails = formatEvaluation(parsed.judges?.description);
  if (descriptionDetails) outputParts.push(`### Description Review\n\n${descriptionDetails}`);

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
    validationIssues: validationIssues.length > 0 ? validationIssues : undefined,
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

/**
 * Files under `dir` that differ from the snapshot — added, modified, or removed
 * — as paths relative to `dir`. Returns `null` when the directory can't be
 * re-enumerated, which is a different answer from an empty list.
 */
async function changedBundleFiles(
  dir: string,
  snapshot: Map<string, Uint8Array>,
): Promise<string[] | null> {
  const current = await snapshotBundle(dir);
  if (!current) return null;

  const changed: string[] = [];
  for (const [rel, bytes] of current) {
    const before = snapshot.get(rel);
    if (!before || !bytesEqual(before, bytes)) changed.push(rel);
  }
  for (const rel of snapshot.keys()) {
    if (!current.has(rel)) changed.push(rel);
  }
  return changed;
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
  workspace?: string,
): Promise<OptimizeResult> {
  const skillDir = dirname(skillFilePath);
  const skillFileName = basename(skillFilePath);

  // SKILL.md alone drives the PR diff, the inline suggestions, and
  // /apply-optimize, so read it up front to compare against afterwards.
  const originalContent = await Bun.file(skillFilePath).text();

  // `review fix` rewrites the whole bundle, so a full snapshot is what makes it
  // revertible and what tells us whether anything outside SKILL.md changed.
  // A directory that can't be enumerated leaves only SKILL.md to work with.
  const bundle = await snapshotBundle(skillDir);
  const restore = async () => {
    if (bundle) await restoreBundle(skillDir, bundle);
    else await Bun.write(skillFilePath, originalContent);
  };

  // `--yes` applies the improved bundle to disk without prompting, which is
  // what lets us score it below before restoring the author's version.
  const proc = Bun.spawn(
    [
      tesslBin(), 'review', 'fix',
      ...(workspace ? ['--workspace', workspace] : []),
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

  const newContent = await Bun.file(skillFilePath).text();
  const skillMdChanged = newContent !== originalContent;

  // A fix can raise the score through reference files rather than SKILL.md, so
  // the whole bundle decides whether an after-score is worth fetching. When the
  // directory can't be re-read, SKILL.md is the only comparison available.
  const changedFiles = bundle ? await changedBundleFiles(skillDir, bundle) : null;
  const bundleFilesChanged = (changedFiles ?? []).filter(
    (rel) => rel !== skillFileName,
  );
  const contentChanged = changedFiles ? changedFiles.length > 0 : skillMdChanged;

  let afterScore = beforeScore;
  if (contentChanged) {
    const reviewProc = Bun.spawn(reviewRunArgs(skillDir, workspace), {
      stdout: 'pipe',
      stderr: 'pipe',
    });
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

  // The author's version goes back on disk; the improvement is offered as a
  // suggestion rather than a commit.
  await restore();

  // `optimized` means "this action can offer the improvement", which requires
  // both a better score and a changed SKILL.md — the only file the diff, the
  // inline suggestions, and /apply-optimize carry. An improvement that lives
  // in reference files reports its score through `bundleFilesChanged` instead,
  // and a run that fails to beat the before-score reports no improvement.
  const optimized = skillMdChanged && afterScore > beforeScore;

  return {
    optimized,
    beforeScore,
    afterScore,
    optimizedContent: optimized ? newContent : undefined,
    originalContent: optimized ? originalContent : undefined,
    bundleFilesChanged:
      bundleFilesChanged.length > 0 ? bundleFilesChanged : undefined,
  };
}
