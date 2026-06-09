# Org Secret Usage Scanner

Composite action that scans **every repository** in an organization and reports
which **organization-level secrets** are referenced from:

- workflow files — `.github/workflows/*.yml` / `*.yaml`
- composite action definitions — any `action.yml` / `action.yaml` in the tree

It cross-references the secret names found against the org's actual secret list
(`GET /orgs/{org}/actions/secrets`) and flags **orphaned** secrets — org secrets
referenced by no repository, i.e. cleanup candidates.

## How it works

1. List org-level secret **names** (the API never exposes values).
2. Enumerate org repos (filterable by name glob, visibility, archived state).
3. For each repo, read the default-branch git tree, pick workflow + `action.yml`
   files, fetch their raw contents (no clone), and grep for `${{ secrets.NAME }}`.
4. A reference whose name matches an org secret = org usage; anything else is
   recorded as `other_secret_refs` (repo/environment secrets or `GITHUB_TOKEN`).
5. Emit a JSON report, a markdown summary, and the run's job summary.

## Required token

The default `GITHUB_TOKEN` **cannot** list organization secrets. Provide one of:

- a **PAT** with `admin:org` (read) + `repo` (contents read), or
- a **GitHub App** installation token with `Organization secrets: read-only`,
  `Contents: read-only`, `Metadata: read-only`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `token` | — (required) | Token with org-secrets read + contents read. |
| `owner` | current repo owner | Organization login to scan. |
| `name_pattern` | `*` | Glob to filter repo names (e.g. `reearth-*`). |
| `repo_visibility` | `all` | `all` \| `public` \| `private`. |
| `include_archived` | `false` | Also scan archived repos. |
| `fail_on_orphans` | `false` | Exit non-zero if any org secret is unused. |
| `output_dir` | `org-secret-scan` | Where report files are written. |

## Outputs

| Output | Description |
|---|---|
| `output_dir` | Directory containing the report files. |
| `report_file` | Path to `org-secret-scan.json`. |
| `secrets_total` | Count of org secrets discovered. |
| `secrets_used` | Org secrets referenced by ≥1 repo. |
| `secrets_orphaned` | Org secrets referenced by no repo. |

## Caveats

- **`secrets: inherit`** — a reusable-workflow call with `secrets: inherit`
  implicitly forwards *all* caller secrets. Such repos are flagged
  (`inherits_all_secrets`) and counted, but orphan detection cannot see which
  specific secrets flow through. Treat orphans as candidates, not certainties.
- **Default branch only.** Other branches are not scanned (Contents API mode).
- **Truncated trees.** Very large repos may truncate the git tree; affected
  repos are flagged `tree_truncated` and some `action.yml` files may be missed.
- **`selected` visibility.** The report includes each secret's visibility but
  does not yet expand the selected-repos allow-list.

## Example workflow

```yaml
name: Org secret usage scan
on:
  schedule:
    - cron: "0 6 * * 1" # weekly, Monday 06:00 UTC
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - name: Scan org secret usage
        id: scan
        uses: reearth/actions/org-secret-usage-scanner@main
        with:
          token: ${{ secrets.ORG_SECRETS_READ_PAT }}
          owner: reearth
          name_pattern: "reearth-*"
          fail_on_orphans: "false"

      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: org-secret-scan
          path: ${{ steps.scan.outputs.output_dir }}
```
