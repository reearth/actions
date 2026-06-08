# compliance-check

Runs the org-wide [git-cascade](https://github.com/eukarya-inc/git-cascade)
compliance rules against a single repository in CI and **fails the job** when
any `error`-severity rule fails. It uses the same ruleset as the weekly
[eukarya-inc/compliance](https://github.com/eukarya-inc/compliance) scan
(`actions-pinned`, `license-exists`, `secret-detection`, `no-secrets-inherit`,
…), scoped to one repository, so violations surface at merge time instead of
waiting for the scheduled scan.

## How it works

The action installs the `git-cascade` CLI and runs:

```
git-cascade scan --org <owner> --include-repo <repo> --config-repo eukarya-inc/compliance
```

git-cascade reads the configuration from `eukarya-inc/compliance` and reads the
target repository's contents **through the GitHub API**. It exits `1` when an
`error`-severity rule fails (`warning`/`info` failures keep exit `0`), which
fails the workflow.

> [!IMPORTANT]
> git-cascade always reads the **default branch** of the scanned repository via
> the API — it cannot read a feature branch or a PR head. Practical
> consequences:
>
> - On `push` to the default branch (i.e. right after a PR is merged) it checks
>   the **just-merged** state. This is the authoritative gate.
> - On `pull_request` it checks the **base branch**, not the PR's proposed
>   changes, so it will not catch a violation introduced by the PR until after
>   merge. Use it as an early signal only.

## Authentication

git-cascade lists the organization's repositories and then reads repository
contents (and, for some rules, branch protection and collaborators). For full
parity with the scheduled scan, supply a **GitHub App token** with:

- Organization → Members: **Read**
- Repository → Metadata, Contents, Administration: **Read**

Issues write is **not** required — this action does not post issues.

Provide `app-id` + `private-key` and the action mints the token for you, or pass
a pre-generated `token`. The default `GITHUB_TOKEN` works for the content-based
rules (`actions-pinned`, `license-exists`, `secret-detection`, …) but lacks
org/admin scope, so `branch-protection` and `external-collaborators` will error.

## Usage

Recommended: run on `push` to the default branch (authoritative, post-merge),
with `pull_request` as an optional early signal.

```yaml
name: Compliance Check
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: reearth/actions/compliance-check@main
        with:
          app-id: ${{ vars.GH_APP_ID }}
          private-key: ${{ secrets.GH_APP_PRIVATE_KEY }}
```

Minimal (default `GITHUB_TOKEN`, content rules only):

```yaml
      - uses: reearth/actions/compliance-check@main
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `app-id` | no | `""` | GitHub App ID/client ID. Use with `private-key` to mint a token. |
| `private-key` | no | `""` | GitHub App private key (PEM) paired with `app-id`. |
| `token` | no | `${{ github.token }}` | Pre-generated token used when `app-id`/`private-key` are unset. |
| `owner` | no | `${{ github.repository_owner }}` | Organization login to scan. |
| `repo` | no | `${{ github.event.repository.name }}` | Repository short name to scan. |
| `config-repo` | no | `eukarya-inc/compliance` | Repository holding the git-cascade config. |
| `config-ref` | no | `""` | Git ref of the config repo (empty = default branch). |
| `git-cascade-version` | no | `v0.11.3` | git-cascade release tag to install. |
| `concurrency` | no | `5` | Concurrent (rule, repo) checks. |
| `format` | no | `table` | Output format: `table`, `json`, `csv`, `sarif`. |
| `output` | no | `""` | Write results to this file instead of stdout. |

## Suppressing false positives

For line-based rules, add a `git-cascade:allow` comment on the flagged line (see
the [git-cascade docs](https://github.com/eukarya-inc/git-cascade#suppressing-false-positives)).
