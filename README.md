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
      - uses: tesslio/skill-review-and-optimize@bff9490027d60847df6494fdac7dccfb3ad82948
```

Any PR that modifies a `SKILL.md` file gets an automated review comment with scores and feedback.

### Review + Optimize (requires Tessl API token)

```yaml
- uses: tesslio/skill-review-and-optimize@bff9490027d60847df6494fdac7dccfb3ad82948
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
      contains(github.event.comment.body, '/apply-optimize')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: tesslio/skill-review-and-optimize@bff9490027d60847df6494fdac7dccfb3ad82948
        with:
          mode: apply
```

When a user comments `/apply-optimize` on a PR that has a Tessl review comment with optimization suggestions, this workflow extracts the optimized content and commits it directly to the PR branch.

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
- uses: tesslio/skill-review-and-optimize@bff9490027d60847df6494fdac7dccfb3ad82948
  with:
    optimize: true
    inline-suggestions: true
    tessl-token: ${{ secrets.TESSL_API_TOKEN }}
```

When `inline-suggestions: true`, each diff hunk between the user's `SKILL.md` and the optimizer's version is posted as a GitHub native `suggestion` block on the file diff. Authors can click "Commit suggestion" on individual hunks to accept changes one at a time, alongside (or instead of) the all-at-once `/apply-optimize` flow.

### Setting a quality gate

```yaml
- uses: tesslio/skill-review-and-optimize@bff9490027d60847df6494fdac7dccfb3ad82948
  with:
    fail-threshold: 70
```

PRs with any skill scoring below 70% will fail the check.

## How it works

1. Detects which `SKILL.md` files were changed in the PR
2. Installs the [Tessl CLI](https://tessl.io)
3. Runs `tessl skill review` on each changed skill
4. If `optimize: true` and `tessl-token` is provided, runs optimization and captures suggested improvements
5. Posts (or updates) a review comment on the PR with scores, feedback, and optimization suggestions
6. Optionally fails the check if any score is below the threshold
7. If a user comments `/apply-optimize`, the apply workflow extracts optimized content from the review comment and commits it to the PR branch

When optimize is enabled but no token is provided, the action runs review-only and includes a prompt in the comment to set up optimization.

## Comment behavior

The action posts a single comment per PR. On subsequent pushes, it updates the existing comment rather than creating a new one. Optimized skills show before/after score badges and the suggested content in a collapsible section.

## Local development

```bash
bun install
bun run lint
bun test
```

## License

MIT
