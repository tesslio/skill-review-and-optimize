import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { SkillReviewResult } from './skill-review.ts';

// ---------------------------------------------------------------------------
// Mock @actions/core and @actions/github at module level
// ---------------------------------------------------------------------------

mock.module('@actions/core', () => ({
  setFailed: mock(() => {}),
  getInput: mock(() => ''),
  info: mock(() => {}),
  warning: mock(() => {}),
  error: mock(() => {}),
  ExitCode: { Success: 0, Failure: 1 },
}));

const listFilesMock = mock(() =>
  Promise.resolve({ data: [] as Array<{ filename: string; status: string }> }),
);

const createCommentMock = mock(() => Promise.resolve());
const updateCommentMock = mock(() => Promise.resolve());
const listCommentsMock = mock(() =>
  Promise.resolve({ data: [] as Array<{ id: number; body: string }> }),
);

mock.module('@actions/github', () => ({
  context: {
    payload: { pull_request: { number: 42 } },
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: () => ({
    rest: {
      pulls: { listFiles: listFilesMock },
      issues: {
        listComments: listCommentsMock,
        createComment: createCommentMock,
        updateComment: updateCommentMock,
      },
    },
  }),
}));

// Import after mock registration
const { getChangedSkillFiles } = await import('./changed-files.ts');
const { runSkillReview, runSkillOptimize, extractJson, parseOptimizeIterations } = await import('./skill-review.ts');
const { postOrUpdateComment } = await import('./comment.ts');
const { parseThreshold } = await import('./main.ts');
const { parseRequestedPath } = await import('./apply.ts');
const {
  pickFenceLength,
  formatSuggestionBody,
  computeSuggestionHunks,
  encodeOptimizedAnchor,
} = await import('./inline-suggestions.ts');

// ---------------------------------------------------------------------------
// 1. parseThreshold
// ---------------------------------------------------------------------------

describe('parseThreshold', () => {
  test('returns 0 for undefined', () => {
    expect(parseThreshold(undefined)).toBe(0);
  });

  test('returns 0 for "0"', () => {
    expect(parseThreshold('0')).toBe(0);
  });

  test('returns 50 for "50"', () => {
    expect(parseThreshold('50')).toBe(50);
  });

  test('returns 100 for "100"', () => {
    expect(parseThreshold('100')).toBe(100);
  });

  test('throws for -1', () => {
    expect(() => parseThreshold('-1')).toThrow('Invalid fail-threshold');
  });

  test('throws for 101', () => {
    expect(() => parseThreshold('101')).toThrow('Invalid fail-threshold');
  });

  test('throws for NaN string', () => {
    expect(() => parseThreshold('NaN')).toThrow('Invalid fail-threshold');
  });

  test('throws for "abc"', () => {
    expect(() => parseThreshold('abc')).toThrow('Invalid fail-threshold');
  });
});

// ---------------------------------------------------------------------------
// 2. extractJson
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  test('extracts JSON from clean input', () => {
    const json = '{"key": "value"}';
    expect(extractJson(json)).toBe(json);
  });

  test('extracts JSON with leading text', () => {
    expect(extractJson('some log output\n{"key": 1}')).toBe('{"key": 1}');
  });

  test('extracts JSON with trailing text', () => {
    expect(extractJson('{"key": 1}\nmore text')).toBe('{"key": 1}');
  });

  test('extracts nested JSON', () => {
    const json = '{"a": {"b": {"c": 1}}}';
    expect(extractJson(`prefix ${json} suffix`)).toBe(json);
  });

  test('handles strings with braces', () => {
    const json = '{"text": "hello { world }"}';
    expect(extractJson(json)).toBe(json);
  });

  test('handles escaped quotes in strings', () => {
    const json = '{"text": "say \\"hello\\""}';
    expect(extractJson(json)).toBe(json);
  });

  test('returns null for no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  test('returns null for unclosed brace', () => {
    expect(extractJson('{ unclosed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. getChangedSkillFiles
// ---------------------------------------------------------------------------

describe('getChangedSkillFiles', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'fake-token';
    listFilesMock.mockClear();
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test('filters for SKILL.md files only', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/my-skill/SKILL.md', status: 'modified' },
        { filename: 'README.md', status: 'modified' },
        { filename: 'src/index.ts', status: 'added' },
        { filename: 'SKILL.md', status: 'added' },
      ],
    });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual(['skills/my-skill/SKILL.md', 'SKILL.md']);
  });

  test('skips removed files', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/removed/SKILL.md', status: 'removed' },
        { filename: 'skills/kept/SKILL.md', status: 'modified' },
      ],
    });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual(['skills/kept/SKILL.md']);
  });

  test('handles pagination (>100 files)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: i === 50 ? 'skills/page1/SKILL.md' : `src/file${i}.ts`,
      status: 'modified',
    }));
    const page2 = [
      { filename: 'skills/page2/SKILL.md', status: 'added' },
      { filename: 'src/other.ts', status: 'modified' },
    ];

    listFilesMock
      .mockResolvedValueOnce({ data: page1 })
      .mockResolvedValueOnce({ data: page2 });

    const result = await getChangedSkillFiles('.');
    expect(result).toEqual([
      'skills/page1/SKILL.md',
      'skills/page2/SKILL.md',
    ]);
    expect(listFilesMock).toHaveBeenCalledTimes(2);
  });

  test('prepends rootPath when not "."', async () => {
    listFilesMock.mockResolvedValueOnce({
      data: [
        { filename: 'skills/my-skill/SKILL.md', status: 'modified' },
      ],
    });

    const result = await getChangedSkillFiles('/workspace');
    expect(result).toEqual(['/workspace/skills/my-skill/SKILL.md']);
  });

  test('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(getChangedSkillFiles('.')).rejects.toThrow(
      'GITHUB_TOKEN is required',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. runSkillReview
// ---------------------------------------------------------------------------

describe('runSkillReview', () => {
  function makeMockSpawn(
    stdout: string,
    stderr: string,
    exitCode: number,
  ) {
    return mock((..._args: unknown[]) => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    }));
  }

  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
  });

  test('successful review with JSON output', async () => {
    const jsonOutput = JSON.stringify({
      contentJudge: {
        normalizedScore: 0.85,
        evaluation: 'Good skill definition.',
      },
      validation: { output: 'All checks passed.' },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 70);
    expect(result.skillPath).toBe('skills/test/SKILL.md');
    expect(result.score).toBe(85);
    expect(result.passed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('All checks passed.');
    expect(result.output).toContain('Good skill definition.');
  });

  test('CLI failure (non-zero exit)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'Command not found', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('Command not found');
  });

  test('CLI failure with threshold 0 still passes', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'some error', 1);

    const result = await runSkillReview('skills/test/SKILL.md', 0);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(-1);
  });

  test('malformed JSON output (unclosed brace)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ broken json !!!', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
    expect(result.passed).toBe(false);
  });

  test('malformed JSON output (matched braces but invalid)', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('{ not: valid: json }', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Failed to parse JSON output');
    expect(result.passed).toBe(false);
  });

  test('no JSON in output', async () => {
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('Some plain text output with no json', '', 0);

    const result = await runSkillReview('skills/test/SKILL.md', 50);
    expect(result.score).toBe(-1);
    expect(result.error).toBe('Could not parse review output');
  });

  test('threshold pass/fail logic', async () => {
    const makeJson = (score: number) =>
      JSON.stringify({
        contentJudge: { normalizedScore: score, evaluation: 'test' },
      });

    // Score 60% with threshold 50 → passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.6), '', 0);
    const passing = await runSkillReview('a/SKILL.md', 50);
    expect(passing.score).toBe(60);
    expect(passing.passed).toBe(true);

    // Score 40% with threshold 50 → failed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.4), '', 0);
    const failing = await runSkillReview('b/SKILL.md', 50);
    expect(failing.score).toBe(40);
    expect(failing.passed).toBe(false);

    // Score 50% with threshold 50 → passed (>= threshold)
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.5), '', 0);
    const boundary = await runSkillReview('c/SKILL.md', 50);
    expect(boundary.score).toBe(50);
    expect(boundary.passed).toBe(true);

    // Any score with threshold 0 → always passed
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(makeJson(0.1), '', 0);
    const noThreshold = await runSkillReview('d/SKILL.md', 0);
    expect(noThreshold.score).toBe(10);
    expect(noThreshold.passed).toBe(true);
  });

  test('formats structured evaluation object into markdown', async () => {
    const jsonOutput = JSON.stringify({
      contentJudge: {
        normalizedScore: 0.5,
        evaluation: {
          scores: {
            conciseness: { score: 2, reasoning: 'Too verbose' },
            actionability: { score: 3, reasoning: 'Good examples' },
          },
          overall_assessment: 'Decent skill with room for improvement.',
          suggestions: ['Be more concise', 'Add validation steps'],
        },
      },
    });

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillReview('a/SKILL.md', 0);
    expect(result.output).toContain('| Dimension |');
    expect(result.output).toContain('| Suggestion |');
    expect(result.output).toContain('**conciseness**');
    expect(result.output).toContain('**actionability**');
    expect(result.output).toContain('Too verbose');
    expect(result.output).toContain('Be more concise');
    expect(result.output).toContain('Add validation steps');
    expect(result.output).not.toContain('**Overall:**');
    expect(result.output).not.toContain('**Suggestions:**');
    expect(result.output).not.toContain('[object Object]');
  });

  test('JSON with prefix and suffix text', async () => {
    const json = JSON.stringify({
      contentJudge: { normalizedScore: 0.72, evaluation: 'decent' },
    });
    const stdout = `Running review...\n${json}\nDone.`;

    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(stdout, '', 0);

    const result = await runSkillReview('a/SKILL.md', 50);
    expect(result.score).toBe(72);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. formatComment (tested via COMMENT_MARKER constant)
// ---------------------------------------------------------------------------

const COMMENT_MARKER = '<!-- tessl-skill-review -->';

// formatComment is not exported, so we test comment formatting indirectly
// through postOrUpdateComment's behavior and by checking the comment body
// passed to the mock.

describe('postOrUpdateComment', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = 'fake-token';
    createCommentMock.mockClear();
    updateCommentMock.mockClear();
    listCommentsMock.mockClear();
    listCommentsMock.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  test('creates a new comment when none exists', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 80, output: 'ok' }],
      50,
    );

    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(updateCommentMock).not.toHaveBeenCalled();

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs.owner).toBe('test-owner');
    expect(callArgs.repo).toBe('test-repo');
    expect(callArgs.issue_number).toBe(42);
    expect(callArgs.body).toContain(COMMENT_MARKER);
  });

  test('updates an existing comment when marker is found', async () => {
    listCommentsMock.mockResolvedValueOnce({
      data: [{ id: 999, body: `${COMMENT_MARKER}\nold comment` }],
    });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 90, output: 'ok' }],
      50,
    );

    expect(updateCommentMock).toHaveBeenCalledTimes(1);
    expect(createCommentMock).not.toHaveBeenCalled();

    const callArgs = (updateCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(callArgs.comment_id).toBe(999);
    expect(callArgs.body).toContain(COMMENT_MARKER);
  });

  test('comment body includes score and skill path', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'skills/my-skill/SKILL.md', passed: true, score: 85, output: 'review output' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('`skills/my-skill/SKILL.md`');
    expect(body).toContain('Tessl%20Review%20Score-85%25');
    expect(body).toContain('✅');
    expect(body).toContain('Tessl Skill Review');
  });

  test('comment body shows ❌ for failed skill', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: false, score: 30, output: 'bad' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('❌');
    expect(body).toContain('Tessl%20Review%20Score-30%25');
  });

  test('comment body shows ⚠️ for errored skill', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: false, score: -1, output: '', error: 'CLI crashed' }],
      50,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('⚠️');
    expect(body).toContain('Error:');
  });

  test('no emoji when threshold is 0', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 50, output: 'ok' }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).not.toContain('✅');
    expect(body).not.toContain('❌');
  });

  test('throws when GITHUB_TOKEN is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(
      postOrUpdateComment(
        [{ skillPath: 'a/SKILL.md', passed: true, score: 80, output: 'ok' }],
        50,
      ),
    ).rejects.toThrow('GITHUB_TOKEN is required');
  });

  test('comment shows optimize CTA when optimize was skipped', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 60, output: 'ok' }],
      0,
      { skipped: true },
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('Tessl API token');
    expect(body).toContain('tessl.io/account/api-keys');
    expect(body).toContain('TESSL_API_TOKEN');
    expect(body).toContain('suggest an optimized version automatically');
  });

  test('comment shows score badges and opportunity sentence when optimized', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{
        skillPath: 'a/SKILL.md',
        passed: true,
        score: 60,
        output: 'review output',
        optimize: {
          optimized: true,
          beforeScore: 60,
          afterScore: 90,
          originalContent: '---\nname: test\n---\nOriginal content',
          optimizedContent: '---\nname: test\n---\nImproved content',
        },
      }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    // Score badges (visual)
    expect(body).toContain('before-60%25');
    expect(body).toContain('after-90%25');
    // Opportunity sentence (textual)
    expect(body).toContain('opportunity to take this skill from 60% to 90%');
    expect(body).toContain('Have a look at the suggestions');
    // Review details collapsed
    expect(body).toContain('Review Details');
    // No removed sections
    expect(body).not.toContain('Key improvements');
    expect(body).not.toContain('View all changes (diff)');
    // No em-dashes in our copy
    expect(body).not.toContain(' — ');
    // Hidden anchor for /apply-optimize
    expect(body).toMatch(/<!--tessl-optimized-b64:a\/SKILL\.md:[A-Za-z0-9+/=]+-->/);
  });

  test('single optimized skill shows bare /apply-optimize CTA', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{
        skillPath: 'skills/only/SKILL.md',
        passed: true,
        score: 60,
        output: 'review output',
        optimize: {
          optimized: true,
          beforeScore: 60,
          afterScore: 90,
          optimizedContent: 'Improved',
        },
      }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('Comment `/apply-optimize` to apply this change');
    expect(body).not.toContain('/apply-optimize skills/only/SKILL.md');
  });

  test('multiple optimized skills show per-skill /apply-optimize CTA', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    const optimize = (before: number, after: number) => ({
      optimized: true,
      beforeScore: before,
      afterScore: after,
      optimizedContent: 'Improved',
    });

    await postOrUpdateComment(
      [
        { skillPath: 'skills/a/SKILL.md', passed: true, score: 60, output: 'a', optimize: optimize(60, 90) },
        { skillPath: 'skills/b/SKILL.md', passed: true, score: 50, output: 'b', optimize: optimize(50, 85) },
      ],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('`/apply-optimize skills/a/SKILL.md`');
    expect(body).toContain('`/apply-optimize skills/b/SKILL.md`');
    expect(body).toContain('or `/apply-optimize` to apply all');
  });

  test('optimize comment keeps the full Suggestion column in the review table', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    const reviewOutput = [
      '### Review Details',
      '',
      '| Dimension | Score | Detail | Suggestion |',
      '|-----------|-------|--------|------------|',
      '| **conciseness** | ██░ 2/3 | verbose detail | suggestion one |',
      '| **actionability** | █░░ 1/3 | vague detail | suggestion two |',
    ].join('\n');

    await postOrUpdateComment(
      [{
        skillPath: 'a/SKILL.md',
        passed: true,
        score: 60,
        output: reviewOutput,
        optimize: {
          optimized: true,
          beforeScore: 60,
          afterScore: 90,
          optimizedContent: 'Improved',
        },
      }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;

    // Suggestion column is intact in the review-details table
    expect(body).toContain('| Suggestion |');
    expect(body).toContain('| suggestion one |');
    expect(body).toContain('| suggestion two |');

    // No standalone "Key improvements" bullet section above the table
    expect(body).not.toContain('Key improvements');
    expect(body).not.toContain('- suggestion one');
  });

  test('comment shows no optimization needed', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{
        skillPath: 'a/SKILL.md',
        passed: true,
        score: 95,
        output: 'great',
        optimize: {
          optimized: false,
          beforeScore: 95,
          afterScore: 95,
        },
      }],
      0,
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).toContain('no optimization needed');
  });

  test('no CTA when optimize not skipped', async () => {
    listCommentsMock.mockResolvedValueOnce({ data: [] });

    await postOrUpdateComment(
      [{ skillPath: 'a/SKILL.md', passed: true, score: 80, output: 'ok' }],
      0,
      { skipped: false },
    );

    const callArgs = (createCommentMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const body = callArgs.body as string;
    expect(body).not.toContain('Tessl API token');
  });
});

// ---------------------------------------------------------------------------
// 6. parseOptimizeIterations
// ---------------------------------------------------------------------------

describe('parseRequestedPath', () => {
  test('returns undefined for bare /apply-optimize', () => {
    expect(parseRequestedPath('/apply-optimize')).toBeUndefined();
  });

  test('returns the path when it ends with SKILL.md', () => {
    expect(parseRequestedPath('/apply-optimize payments/SKILL.md'))
      .toBe('payments/SKILL.md');
  });

  test('returns undefined for chatty comments without a SKILL.md path', () => {
    expect(parseRequestedPath('/apply-optimize when you get a chance')).toBeUndefined();
    expect(parseRequestedPath('Hey can you /apply-optimize for me?')).toBeUndefined();
  });

  test('handles tab-separated paths', () => {
    expect(parseRequestedPath('/apply-optimize\tpayments/SKILL.md'))
      .toBe('payments/SKILL.md');
  });

  test('finds the command anywhere in the body', () => {
    expect(parseRequestedPath('Sure thing — /apply-optimize a/SKILL.md please'))
      .toBe('a/SKILL.md');
  });

  test('returns undefined when path is on a different line than the command', () => {
    expect(parseRequestedPath('/apply-optimize\npayments/SKILL.md')).toBeUndefined();
  });
});

describe('parseOptimizeIterations', () => {
  test('returns 3 for undefined', () => {
    expect(parseOptimizeIterations(undefined)).toBe(3);
  });

  test('returns valid values 1-10', () => {
    expect(parseOptimizeIterations('1')).toBe(1);
    expect(parseOptimizeIterations('5')).toBe(5);
    expect(parseOptimizeIterations('10')).toBe(10);
  });

  test('throws for 0', () => {
    expect(() => parseOptimizeIterations('0')).toThrow('Invalid optimize-iterations');
  });

  test('throws for 11', () => {
    expect(() => parseOptimizeIterations('11')).toThrow('Invalid optimize-iterations');
  });

  test('throws for non-integer', () => {
    expect(() => parseOptimizeIterations('2.5')).toThrow('Invalid optimize-iterations');
  });

  test('throws for "abc"', () => {
    expect(() => parseOptimizeIterations('abc')).toThrow('Invalid optimize-iterations');
  });
});

// ---------------------------------------------------------------------------
// 7. runSkillOptimize
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. inline-suggestions: pickFenceLength, formatSuggestionBody, computeSuggestionHunks
// ---------------------------------------------------------------------------

describe('pickFenceLength', () => {
  test('returns 3 for plain content with no backticks', () => {
    expect(pickFenceLength('plain content')).toBe(3);
  });

  test('returns 3 for content with inline backticks (single)', () => {
    expect(pickFenceLength('use `foo` for inline code')).toBe(3);
  });

  test('returns 4 when content contains a 3-backtick fence', () => {
    const content = 'before\n```\ncode\n```\nafter';
    expect(pickFenceLength(content)).toBe(4);
  });

  test('returns 5 when content contains a 4-backtick fence', () => {
    const content = 'before\n````\ncode\n````\nafter';
    expect(pickFenceLength(content)).toBe(5);
  });

  test('returns max+1 when multiple fence lengths are mixed', () => {
    const content = '```\nshort\n```\n````\nlonger\n````';
    expect(pickFenceLength(content)).toBe(5);
  });
});

describe('formatSuggestionBody', () => {
  test('wraps plain content in a 3-backtick suggestion fence', () => {
    const result = formatSuggestionBody('hello world');
    expect(result).toBe('```suggestion\nhello world\n```');
  });

  test('uses longer fence when content has nested backticks', () => {
    const content = '```\ncode\n```';
    const result = formatSuggestionBody(content);
    expect(result.startsWith('````suggestion\n')).toBe(true);
    expect(result.endsWith('\n````')).toBe(true);
    expect(result).toContain(content);
  });

  test('includes intro text above the suggestion block', () => {
    const result = formatSuggestionBody('new', 'Consider this:');
    expect(result.startsWith('Consider this:\n\n```suggestion\n')).toBe(true);
  });

  test('handles empty content (pure deletion)', () => {
    expect(formatSuggestionBody('')).toBe('```suggestion\n\n```');
  });
});

describe('computeSuggestionHunks', () => {
  test('returns no hunks when content is identical', () => {
    expect(computeSuggestionHunks('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  test('detects a single-line modification', () => {
    const original = 'line one\nline two\nline three';
    const optimized = 'line one\nLINE TWO\nline three';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.startLine).toBe(2);
    expect(hunks[0]?.endLine).toBe(2);
    expect(hunks[0]?.newContent).toBe('LINE TWO');
  });

  test('detects a multi-line modification', () => {
    const original = 'a\nb\nc\nd\ne';
    const optimized = 'a\nB1\nB2\nC1\nd\ne';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.startLine).toBe(2);
    expect(hunks[0]?.endLine).toBe(3);
    expect(hunks[0]?.newContent).toBe('B1\nB2\nC1');
  });

  test('detects a pure deletion (empty newContent)', () => {
    const original = 'keep\nremove me\nkeep';
    const optimized = 'keep\nkeep';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.newContent).toBe('');
  });

  test('detects a pure insertion (anchored to preceding line)', () => {
    const original = 'a\nc';
    const optimized = 'a\nb\nc';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.startLine).toBe(hunks[0]?.endLine);
    // Mid-file insertion: anchor line "a" first, then "b"
    expect(hunks[0]?.newContent).toBe('a\nb');
  });

  test('top-of-file insertion places new content before line 1', () => {
    const original = 'second\nthird';
    const optimized = 'first\nsecond\nthird';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.startLine).toBe(1);
    expect(hunks[0]?.endLine).toBe(1);
    // Inserted content must come *before* the original line 1
    expect(hunks[0]?.newContent).toBe('first\nsecond');
  });

  test('CRLF line endings do not produce false-positive hunks', () => {
    const originalCrlf = 'line one\r\nline two\r\nline three';
    const optimizedLf = 'line one\nline two\nline three';
    expect(computeSuggestionHunks(originalCrlf, optimizedLf)).toEqual([]);
  });

  test('CRLF input strips \\r from suggestion bodies', () => {
    const originalCrlf = 'line one\r\nline two\r\nline three';
    const optimizedCrlf = 'line one\r\nLINE TWO\r\nline three';
    const hunks = computeSuggestionHunks(originalCrlf, optimizedCrlf);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.newContent).toBe('LINE TWO');
    expect(hunks[0]?.newContent).not.toContain('\r');
  });

  test('produces multiple hunks for non-contiguous changes', () => {
    const original = 'a\nb\nc\nd\ne\nf\ng';
    const optimized = 'a\nB\nc\nd\nE\nf\ng';
    const hunks = computeSuggestionHunks(original, optimized);
    expect(hunks).toHaveLength(2);
  });
});

describe('encodeOptimizedAnchor', () => {
  test('produces a single-line HTML comment with base64-encoded content', () => {
    const anchor = encodeOptimizedAnchor('foo/SKILL.md', 'hello world');
    expect(anchor).toMatch(/^<!--tessl-optimized-b64:foo\/SKILL\.md:[A-Za-z0-9+/=]+-->$/);
    // No literal newlines so it stays a single line in the comment
    expect(anchor).not.toContain('\n');
  });

  test('round-trips arbitrary markdown content via base64', () => {
    const content = '---\nname: x\n---\n# Heading\n\n```ts\nconst y = 1;\n```\n';
    const anchor = encodeOptimizedAnchor('skills/x/SKILL.md', content);
    const match = anchor.match(/<!--tessl-optimized-b64:.+?:([A-Za-z0-9+/=]+)-->/);
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });
});

describe('runSkillOptimize', () => {
  let originalSpawn: typeof Bun.spawn;
  let originalFile: typeof Bun.file;
  let originalWrite: typeof Bun.write;

  function makeMockSpawn(stdout: string, stderr: string, exitCode: number) {
    return mock((..._args: unknown[]) => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stderr));
          controller.close();
        },
      }),
      exited: Promise.resolve(exitCode),
    }));
  }

  beforeEach(() => {
    originalSpawn = Bun.spawn;
    originalFile = Bun.file;
    originalWrite = Bun.write;
  });

  afterEach(() => {
    // @ts-ignore restoring original
    Bun.spawn = originalSpawn;
    // @ts-ignore restoring original
    Bun.file = originalFile;
    // @ts-ignore restoring original
    Bun.write = originalWrite;
  });

  test('successful optimization with content change', async () => {
    const originalContent = '---\nname: test\n---\nOriginal';
    const optimizedContent = '---\nname: test\n---\nOptimized';
    let readCount = 0;

    // @ts-expect-error mock assignment
    Bun.file = mock(() => ({
      text: mock(() => {
        readCount++;
        // First read: original, second read: optimized
        return Promise.resolve(readCount === 1 ? originalContent : optimizedContent);
      }),
    }));
    // @ts-ignore mock assignment
    Bun.write = mock(() => Promise.resolve(0));

    const jsonOutput = JSON.stringify({
      contentJudge: { normalizedScore: 0.92 },
    });
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillOptimize('skills/test/SKILL.md', 60, 3);
    expect(result.optimized).toBe(true);
    expect(result.beforeScore).toBe(60);
    expect(result.afterScore).toBe(92);
    expect(result.optimizedContent).toBe(optimizedContent);
    expect(result.error).toBeUndefined();
  });

  test('optimization with no content change', async () => {
    const content = '---\nname: test\n---\nAlready good';

    // @ts-expect-error mock assignment
    Bun.file = mock(() => ({
      text: mock(() => Promise.resolve(content)),
    }));
    // @ts-ignore mock assignment
    Bun.write = mock(() => Promise.resolve(0));

    const jsonOutput = JSON.stringify({
      contentJudge: { normalizedScore: 0.95 },
    });
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    const result = await runSkillOptimize('skills/test/SKILL.md', 95, 3);
    expect(result.optimized).toBe(false);
    expect(result.beforeScore).toBe(95);
    expect(result.afterScore).toBe(95);
    expect(result.optimizedContent).toBeUndefined();
  });

  test('CLI failure returns error', async () => {
    // @ts-expect-error mock assignment
    Bun.file = mock(() => ({
      text: mock(() => Promise.resolve('original')),
    }));
    // @ts-ignore mock assignment
    Bun.write = mock(() => Promise.resolve(0));
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn('', 'auth error', 1);

    const result = await runSkillOptimize('skills/test/SKILL.md', 50, 3);
    expect(result.optimized).toBe(false);
    expect(result.error).toContain('Optimize exited with code 1');
    expect(result.beforeScore).toBe(50);
    expect(result.afterScore).toBe(50);
  });

  test('restores original file after optimization', async () => {
    const originalContent = 'original';
    let readCount = 0;

    // @ts-expect-error mock assignment
    Bun.file = mock(() => ({
      text: mock(() => {
        readCount++;
        return Promise.resolve(readCount === 1 ? originalContent : 'optimized');
      }),
    }));
    const writeMock = mock(() => Promise.resolve(0));
    // @ts-ignore mock assignment
    Bun.write = writeMock;

    const jsonOutput = JSON.stringify({ contentJudge: { normalizedScore: 0.9 } });
    // @ts-expect-error mock assignment
    Bun.spawn = makeMockSpawn(jsonOutput, '', 0);

    await runSkillOptimize('skills/test/SKILL.md', 50, 3);

    // Should have called write to restore original content
    expect(writeMock).toHaveBeenCalled();
    const lastWriteArgs = (writeMock.mock.calls[writeMock.mock.calls.length - 1] as unknown[]);
    expect(lastWriteArgs[1]).toBe(originalContent);
  });
});
