# Tessl Skill Review & Optimize Action

A GitHub Action that reviews `SKILL.md` files changed in a pull request and optionally optimizes them with AI-powered suggestions.

## Usage

Examples below pin this action to a specific commit SHA so your workflow stays reproducible and does not pick up unexpected changes from `main`. Replace the SHA when you intentionally upgrade; you can also use a [release tag](https://github.com/tesslio/skill-review-and-optimize/tags) if one is published.

### Review only (no authentication required)

```yaml
name: Skill Review
on:
  pull_request:
    paths: ['**/SKILL.md']

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tesslio/skill-review-and-optimize@ed1dbae31e43692562bb395bd0dacdc6cb8ec76a
```

Any PR that modifies a `SKILL.md` file gets an automated review comment with scores and feedback.

### Review + Optimize (requires Tessl API token)

```yaml
- uses: tesslio/skill-review-and-optimize@ed1dbae31e43692562bb395bd0dacdc6cb8ec76a
  with:
    optimize: true
    tessl-token: ${{ secrets.TESSL_API_TOKEN }}
```

When optimize is enabled, the action reviews each skill, then runs AI-powered optimization and posts the suggested improved `SKILL.md` content directly in the PR comment. Users can then comment `/apply-optimize` to commit the optimized content to the PR branch.

### Apply optimized content (via `/apply-optimize` comment)

Add a second workflow to let PR authors apply suggested optimizations with a single comment:

```yaml
name: Apply Skill Optimization
on:
  issue_comment:
    types: [created]

jobs:
  apply:
    if: >
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '/apply-optimize') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: tesslio/skill-review-and-optimize@ed1dbae31e43692562bb395bd0dacdc6cb8ec76a
        with:
          mode: apply
```

When a repo collaborator comments `/apply-optimize` on a PR that has a Tessl review comment with optimization suggestions, this workflow extracts the optimized content and commits it directly to the PR branch.

> **Security:** the `author_association` filter restricts `/apply-optimize` to repo collaborators. The action also enforces this at runtime as defense in depth, so a missing or relaxed filter cannot let an arbitrary commenter trigger commits to your PR branch.

When a PR has more than one optimized skill, you can apply just one of them by including the path:

```
/apply-optimize path/to/SKILL.md
```

The review comment shows the exact command to copy for each skill. Bare `/apply-optimize` still applies all optimized skills at once.

#### Getting a TESSL_API_TOKEN

1. Sign up or log in at [tessl.io](https://tessl.io)
2. Get your API token at [tessl.io/account/api-keys](https://tessl.io/account/api-keys)
3. Add it as a repository secret named `TESSL_API_TOKEN`

No CLI install or workspace setup required.

## Inputs

| Input | Description | Default |
|---|---|---|
| `mode` | Action mode: `review` or `apply` | `review` |
| `path` | Root path to search for SKILL.md files | `.` |
| `comment` | Whether to post results as a PR comment | `true` |
| `fail-threshold` | Minimum score (0-100) to pass. Set to `0` to never fail. | `0` |
| `optimize` | Run skill optimization after review (requires `tessl-token`) | `false` |
| `optimize-iterations` | Max optimization iterations (1-10) | `3` |
| `inline-suggestions` | Post optimization changes as inline GitHub `suggestion` blocks on the PR diff (cherry-pick individual changes) | `false` |
| `tessl-token` | Tessl API token for optimize mode | _(optional)_ |

### Cherry-picking individual changes (inline suggestions)

```yaml
- uses: tesslio/skill-review-and-optimize@ed1dbae31e43692562bb395bd0dacdc6cb8ec76a
  with:
    optimize: true
    inline-suggestions: true
    tessl-token: ${{ secrets.TESSL_API_TOKEN }}
```

When `inline-suggestions: true`, each diff hunk between the user's `SKILL.md` and the optimizer's version is posted as a GitHub native `suggestion` block on the file diff. Authors can click "Commit suggestion" on individual hunks to accept changes one at a time, alongside (or instead of) the all-at-once `/apply-optimize` flow.

### Setting a quality gate

```yaml
- uses: tesslio/skill-review-and-optimize@ed1dbae31e43692562bb395bd0dacdc6cb8ec76a
  with:
    fail-threshold: 70
```

PRs where any skill scores below 70% will fail the check.

When `optimize: true`, the threshold is checked against the **post-optimize achievable score**, not the user's current draft. So a skill the optimizer can lift above the threshold passes the check — the user has a one-click path to merge via `/apply-optimize`. This avoids the contradictory UX where the comment shows a 85% optimized score but the check still blocks at the original 50%.

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io)
3. Runs `tessl skill review` on each changed skill
4. If `optimize: true` and `tessl-token` is provided, runs optimization and captures suggested improvements
5. Posts (or updates) a summary comment on the PR with the score, an opportunity-framed headline, a review-details table per dimension, and a CTA pointing at the Files Changed tab
6. If `inline-suggestions: true`, also posts a single batched PR review with one inline `suggestion` block per diff hunk so authors can click "Commit suggestion" to cherry-pick changes
7. Optionally fails the check if any score is below the threshold
8. If a repo collaborator comments `/apply-optimize`, the apply workflow extracts optimized content from the summary comment and commits it to the PR branch

When optimize is enabled but no token is provided, the action runs review-only and includes a prompt in the comment to set up optimization.

## Comment behavior

The action posts a single summary comment per PR. On subsequent pushes, it updates the existing comment in place rather than creating a new one. The summary shows before/after score badges, an opportunity headline, a review-details table with per-dimension feedback (Suggestion column included), and a CTA. The full optimized content is stored as a hidden base64 anchor so `/apply-optimize` can still extract it without cluttering the rendered view.

When `inline-suggestions: true`, each PR run also posts a single batched review on the Files Changed tab. Prior bot suggestion comments from earlier runs are deleted before posting so suggestions don't pile up on the same line across re-runs.

## Local development

```bash
bun install
bun run lint
bun test
```

## License

MIT
