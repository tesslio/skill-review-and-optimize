# Tessl Skill Review

Enforce agent skill quality in your CI. The bot reviews every `SKILL.md` changed in a PR, scores it, and posts inline suggestions the author can accept with one click.

## What you'll see when a PR changes a SKILL.md

- A summary comment with a quality score and a per-dimension review of the skill
- Inline `suggestion` blocks on the Files Changed tab — click **Commit suggestion** to accept changes one at a time, or use **Add suggestion to batch** to combine several into one commit
- `/apply-optimize` (per skill or for the whole PR) as a one-shot way to take all changes via the bot

## Setup

1. Get a [Tessl API token](https://tessl.io/account/api-keys) and add it as a repository secret named `TESSL_API_TOKEN`.

2. Add `.github/workflows/skill-review.yml`:

   ```yaml
   name: Tessl Skill Review
   on:
     pull_request:
       paths: ['**/SKILL.md']
     issue_comment:
       types: [created]

   jobs:
     review:
       if: github.event_name == 'pull_request'
       runs-on: ubuntu-latest
       permissions:
         pull-requests: write
         contents: read
       steps:
         - uses: actions/checkout@v4
         - uses: tesslio/skill-review-and-optimize@e7b9c063fc4192045558f5919784b6f7c16969ea
           with:
             optimize: true
             inline-suggestions: true
             tessl-token: ${{ secrets.TESSL_API_TOKEN }}

     apply:
       if: >
         github.event_name == 'issue_comment' &&
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
         - uses: tesslio/skill-review-and-optimize@e7b9c063fc4192045558f5919784b6f7c16969ea
           with:
             mode: apply
   ```

That's it. Open a PR that changes a `SKILL.md` and the bot will comment.

> **The pinned SHA** (`@e7b9c0…`) keeps your workflow reproducible. Bump it from the [tags page](https://github.com/tesslio/skill-review-and-optimize/tags) when you intentionally upgrade.
>
> **Already wired this up as two separate workflows** (`skill-review.yml` + `apply-optimize.yml`) from an earlier setup? No migration needed — both patterns work identically. The single-file workflow above is just simpler to copy from scratch.

## Optional: block PRs below a quality threshold

Add `fail-threshold` to the `review` job to fail the check when a skill scores below your minimum:

```yaml
- uses: tesslio/skill-review-and-optimize@e7b9c063fc4192045558f5919784b6f7c16969ea
  with:
    optimize: true
    inline-suggestions: true
    fail-threshold: 70
    tessl-token: ${{ secrets.TESSL_API_TOKEN }}
```

When `optimize: true`, the threshold is checked against the **post-optimize achievable score**. So skills the optimizer can lift above the threshold pass the check — the user has a one-click `/apply-optimize` path to merge. Skills even the optimizer can't lift fail (genuine quality issue).

## Inputs reference

| Input | Description | Default |
|---|---|---|
| `tessl-token` | Tessl API token. Required for `optimize: true`. [Get one here](https://tessl.io/account/api-keys). | _(required for optimize)_ |
| `optimize` | Run AI-powered optimization after review | `false` |
| `inline-suggestions` | Post inline `suggestion` blocks on the PR file diff | `false` |
| `fail-threshold` | Minimum score (0-100) to pass the check. `0` = never fail. | `0` |
| `optimize-iterations` | Max optimization iterations (1-10) | `3` |
| `mode` | `review` (default) or `apply` (used by the `/apply-optimize` job) | `review` |
| `path` | Root path to search for `SKILL.md` files (for monorepos) | `.` |
| `comment` | Whether to post the summary comment | `true` |

## How it works

1. Detects which `SKILL.md` files changed in the PR
2. Runs `tessl skill review` on each one for a quality score
3. If `optimize: true`, runs the optimizer to suggest improvements (requires `tessl-token`)
4. Posts (or updates) a single summary comment per PR with the score and per-dimension review
5. If `inline-suggestions: true`, also posts a single batched PR review with one inline `suggestion` block per diff hunk; prior bot suggestions are cleaned up before each new run
6. If `fail-threshold` is set, fails the check when the post-optimize achievable score is below threshold
7. When a repo collaborator comments `/apply-optimize`, the apply job extracts the optimized content from the summary comment and commits it to the PR branch

## Local development

```bash
bun install
bun run lint
bun test
```

## License

MIT
