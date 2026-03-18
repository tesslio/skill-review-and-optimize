import * as core from '@actions/core';
import { getChangedSkillFiles } from './changed-files.ts';
import { postOrUpdateComment } from './comment.ts';
import type { SkillReviewResult } from './skill-review.ts';
import { parseOptimizeIterations, runSkillOptimize, runSkillReview } from './skill-review.ts';

const CONCURRENCY_LIMIT = 5;

async function main(): Promise<void> {
  const rootPath = process.env.INPUT_PATH || '.';
  const shouldComment = process.env.INPUT_COMMENT !== 'false';
  const threshold = parseThreshold(process.env.INPUT_FAIL_THRESHOLD);
  const optimizeEnabled = process.env.INPUT_OPTIMIZE === 'true';
  const maxIterations = parseOptimizeIterations(process.env.INPUT_OPTIMIZE_ITERATIONS);

  // 1. Detect changed SKILL.md files
  const changedFiles = await getChangedSkillFiles(rootPath);

  if (changedFiles.length === 0) {
    console.log('No SKILL.md files changed in this PR. Nothing to review.');
    return;
  }

  console.log(
    `Found ${changedFiles.length} changed SKILL.md file(s): ${changedFiles.join(', ')}`,
  );

  // 2. Register token with GitHub log masker
  if (process.env.TESSL_API_TOKEN) {
    core.setSecret(process.env.TESSL_API_TOKEN);
  }

  // 3. Run reviews with concurrency limit
  const results: SkillReviewResult[] = [];
  for (let i = 0; i < changedFiles.length; i += CONCURRENCY_LIMIT) {
    const batch = changedFiles.slice(i, i + CONCURRENCY_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async (filePath) => {
        console.log(`Reviewing ${filePath}...`);
        const result = await runSkillReview(filePath, threshold);
        const status = result.error
          ? 'ERROR'
          : result.passed
            ? 'PASSED'
            : 'FAILED';
        console.log(`  ${filePath}: ${status} (score: ${result.score})`);
        return result;
      }),
    );
    results.push(...batchResults);
  }

  // 4. Run optimization if enabled
  let optimizeSkipped = false;
  if (optimizeEnabled) {
    if (!process.env.TESSL_API_TOKEN) {
      optimizeSkipped = true;
      core.warning('Optimize requested but TESSL_API_TOKEN not provided. Skipping optimization.');
    } else {
      for (let i = 0; i < results.length; i += CONCURRENCY_LIMIT) {
        const batch = results.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(
          batch.map(async (result) => {
            if (result.error) return;
            console.log(`Optimizing ${result.skillPath}...`);
            const optimizeResult = await runSkillOptimize(
              result.skillPath,
              result.score,
              maxIterations,
            );
            result.optimize = optimizeResult;
            if (optimizeResult.optimized) {
              console.log(
                `  ${result.skillPath}: optimized (${optimizeResult.beforeScore}% → ${optimizeResult.afterScore}%)`,
              );
            } else if (optimizeResult.error) {
              console.log(`  ${result.skillPath}: optimize error: ${optimizeResult.error}`);
            } else {
              console.log(`  ${result.skillPath}: no optimization needed`);
            }
          }),
        );
      }
    }
  }

  // 5. Post PR comment (may fail on fork PRs due to read-only token)
  if (shouldComment) {
    try {
      await postOrUpdateComment(results, threshold, { skipped: optimizeSkipped });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Could not post PR comment (expected for fork PRs): ${msg}`);
    }
  }

  // 6. Check threshold
  if (threshold > 0) {
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const summary = failed
        .map((r) => `  ${r.skillPath}: ${r.score >= 0 ? `${r.score}%` : 'error'}`)
        .join('\n');
      core.setFailed(
        `${failed.length} skill(s) below threshold of ${threshold}%:\n${summary}`,
      );
    }
  }

  console.log('Skill review completed successfully.');
}

export function parseThreshold(value: string | undefined): number {
  const num = Number(value ?? '0');
  if (Number.isNaN(num) || num < 0 || num > 100) {
    throw new Error(
      `Invalid fail-threshold: ${value}. Must be a number between 0 and 100.`,
    );
  }
  return num;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
