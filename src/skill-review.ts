import { dirname, join } from 'node:path';

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
      const [key, val] = entries[i];
      const label = key.replace(/_/g, ' ');
      const bar = typeof val.score === 'number' ? scoreBar(val.score) : '—';
      const reasoning = trimFiller(val.reasoning ?? '').replace(/\|/g, '\\|');
      const suggestion = trimFiller(suggestions[i] ?? '').replace(/\|/g, '\\|');
      parts.push(`| **${label}** | ${bar} | ${reasoning} | ${suggestion} |`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(value, null, 2);
}

/** Safely convert an unknown value to a readable string */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
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
  error?: string;
}

export interface SkillReviewResult {
  skillPath: string;
  passed: boolean;
  score: number;
  output: string;
  error?: string;
  optimize?: OptimizeResult;
}

export async function runSkillReview(
  skillFilePath: string,
  threshold: number,
): Promise<SkillReviewResult> {
  const skillDir = dirname(skillFilePath);

  const proc = Bun.spawn(['tessl', 'skill', 'review', '--json', skillDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.warn(
      `tessl skill review failed for ${skillFilePath} (exit code ${exitCode}): ${stderr}`,
    );
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: '',
      error: stderr || `Process exited with code ${exitCode}`,
    };
  }

  const jsonStr = extractJson(stdout);
  if (!jsonStr) {
    console.warn(`No JSON found in skill review output for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: stdout,
      error: 'Could not parse review output',
    };
  }
  let parsed: {
    contentJudge?: { normalizedScore?: number; evaluation?: unknown };
    validation?: { output?: unknown };
  };

  try {
    parsed = JSON.parse(jsonStr) as typeof parsed;
  } catch {
    console.warn(`Failed to parse skill review JSON for ${skillFilePath}`);
    return {
      skillPath: skillFilePath,
      passed: threshold === 0,
      score: -1,
      output: jsonStr,
      error: 'Failed to parse JSON output',
    };
  }

  const normalizedScore = parsed.contentJudge?.normalizedScore ?? 0;
  const score = Math.round(normalizedScore * 100);

  const outputParts: string[] = [];
  if (parsed.validation?.output) {
    outputParts.push(
      '### Validation Checks\n\n' + stringify(parsed.validation.output),
    );
  }
  if (parsed.contentJudge?.evaluation) {
    outputParts.push(
      '### Review Details\n\n' + formatEvaluation(parsed.contentJudge.evaluation),
    );
  }

  return {
    skillPath: skillFilePath,
    passed: threshold === 0 || score >= threshold,
    score,
    output: outputParts.length > 0 ? outputParts.join('\n\n') : stdout,
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
): Promise<OptimizeResult> {
  const skillDir = dirname(skillFilePath);

  // Read original content to detect changes and restore afterward
  const originalContent = await Bun.file(skillFilePath).text();

  const proc = Bun.spawn(
    [
      'tessl', 'skill', 'review',
      '--optimize', '--yes',
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
    console.warn(`tessl optimize stderr: ${safeStderr}`);
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

  // Get after-score by running a separate review (--json not supported with --optimize)
  let afterScore = beforeScore;
  if (contentChanged) {
    const reviewProc = Bun.spawn(
      ['tessl', 'skill', 'review', '--json', skillDir],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const reviewStdout = await new Response(reviewProc.stdout).text();
    await reviewProc.exited;
    const jsonStr = extractJson(reviewStdout);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr) as {
          contentJudge?: { normalizedScore?: number };
        };
        if (typeof parsed.contentJudge?.normalizedScore === 'number') {
          afterScore = Math.round(parsed.contentJudge.normalizedScore * 100);
        }
      } catch {
        // Score parsing failed; keep beforeScore
      }
    }
  }

  // Restore original file (suggestion-only mode)
  await Bun.write(skillFilePath, originalContent);

  return {
    optimized: contentChanged,
    beforeScore,
    afterScore,
    optimizedContent: contentChanged ? newContent : undefined,
  };
}
