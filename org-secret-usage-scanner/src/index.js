const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const { minimatch } = require("minimatch");

const CONCURRENCY = 10;
const API_HEADERS = { "x-github-api-version": "2026-03-10" };

// GitHub Actions expression references: ${{ secrets.NAME }}.
// Secret names are [A-Za-z_][A-Za-z0-9_]* (cannot start with a digit, stored upper-cased).
const SECRET_REF_RE = /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g;
// `secrets: inherit` on a reusable-workflow call implicitly passes ALL caller
// secrets (org + repo) to the callee — an implicit reference to every org secret.
const SECRET_INHERIT_RE = /^\s*secrets:\s*inherit\s*$/;

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─── Org secrets ──────────────────────────────────────────────────────────────

async function listOrgSecrets(octokit, org) {
  // octokit.paginate merges the `secrets` array across pages.
  const secrets = await octokit.paginate("GET /orgs/{org}/actions/secrets", {
    org,
    per_page: 100,
    headers: API_HEADERS,
  });
  const map = new Map();
  for (const s of secrets) {
    map.set(s.name, {
      name: s.name,
      visibility: s.visibility, // all | private | selected
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
  }
  return map;
}

// ─── Repositories ───────────────────────────────────────────────────────────

async function listRepos(octokit, org, visibility, includeArchived, namePattern) {
  const type = visibility === "all" ? "all" : visibility; // public | private | all
  const repos = await octokit.paginate("GET /orgs/{org}/repos", {
    org,
    type,
    per_page: 100,
    headers: API_HEADERS,
  });
  return repos.filter((r) => {
    if (!includeArchived && r.archived) return false;
    if (r.disabled) return false;
    return minimatch(r.name, namePattern);
  });
}

// Return the list of scannable file paths in a repo: workflow files under
// .github/workflows and every action.yml / action.yaml anywhere in the tree.
async function listScanPaths(octokit, owner, repo, defaultBranch) {
  if (!defaultBranch) return { paths: [], truncated: false };
  let tree;
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      {
        owner,
        repo,
        tree_sha: defaultBranch,
        recursive: "1",
        headers: API_HEADERS,
      }
    );
    tree = data;
  } catch (err) {
    core.warning(`[${repo}] failed to read git tree: ${err.message}`);
    return { paths: [], truncated: false };
  }

  const paths = [];
  for (const entry of tree.tree || []) {
    if (entry.type !== "blob") continue;
    const p = entry.path;
    const isWorkflow =
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);
    const isAction = /(^|\/)action\.ya?ml$/.test(p);
    if (isWorkflow || isAction) paths.push(p);
  }
  return { paths, truncated: Boolean(tree.truncated) };
}

async function fetchFile(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner,
        repo,
        path: filePath,
        headers: { accept: "application/vnd.github.raw+json", ...API_HEADERS },
      }
    );
    // With the raw media type, octokit returns the file body as a string.
    return typeof data === "string" ? data : "";
  } catch (err) {
    core.warning(`[${repo}] failed to read ${filePath}: ${err.message}`);
    return "";
  }
}

// Parse a file body for secret references. Returns { refs: [{name,line}], inherits: [line] }.
function parseRefs(content) {
  const lines = content.split(/\r?\n/);
  const refs = [];
  const inherits = [];
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (SECRET_INHERIT_RE.test(line)) inherits.push(lineNo);
    let m;
    SECRET_REF_RE.lastIndex = 0;
    while ((m = SECRET_REF_RE.exec(line)) !== null) {
      refs.push({ name: m[1], line: lineNo });
    }
  });
  return { refs, inherits };
}

// ─── Scan ───────────────────────────────────────────────────────────────────

async function scanRepo(octokit, owner, repo, orgSecretNames) {
  const result = {
    repo: repo.name,
    archived: repo.archived,
    org_secrets_used: new Map(), // name -> [{file, line}]
    other_refs: new Map(), // name -> [{file, line}]  (repo/env/built-in secrets)
    inherits: [], // [{file, line}]
    files_scanned: 0,
    truncated: false,
  };

  const { paths, truncated } = await listScanPaths(
    octokit,
    owner,
    repo.name,
    repo.default_branch
  );
  result.truncated = truncated;
  if (truncated) {
    core.warning(
      `[${repo.name}] git tree truncated — some action.yml files may be missed`
    );
  }

  for (const filePath of paths) {
    const content = await fetchFile(octokit, owner, repo.name, filePath);
    if (!content) continue;
    result.files_scanned++;
    const { refs, inherits } = parseRefs(content);
    for (const ln of inherits) result.inherits.push({ file: filePath, line: ln });
    for (const ref of refs) {
      const bucket = orgSecretNames.has(ref.name)
        ? result.org_secrets_used
        : result.other_refs;
      if (!bucket.has(ref.name)) bucket.set(ref.name, []);
      bucket.get(ref.name).push({ file: filePath, line: ref.line });
    }
  }
  return result;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function buildReport(org, orgSecrets, repoResults) {
  const orgSecretNames = new Set(orgSecrets.keys());

  // secret name -> references across repos
  const secretUsage = new Map();
  for (const name of orgSecretNames) secretUsage.set(name, []);

  const repos = {};
  let inheritReposCount = 0;

  for (const r of repoResults) {
    if (!r) continue;
    const inheritsAll = r.inherits.length > 0;
    if (inheritsAll) inheritReposCount++;

    const usedNames = [...r.org_secrets_used.keys()].sort();
    repos[r.repo] = {
      archived: r.archived,
      files_scanned: r.files_scanned,
      tree_truncated: r.truncated,
      org_secrets_used: usedNames,
      inherits_all_secrets: inheritsAll,
      inherit_locations: r.inherits,
      other_secret_refs: [...r.other_refs.keys()].sort(),
    };

    for (const [name, locs] of r.org_secrets_used) {
      secretUsage.get(name).push(
        ...locs.map((l) => ({ repo: r.repo, file: l.file, line: l.line }))
      );
    }
  }

  const orgSecretsReport = {};
  const orphaned = [];
  let usedCount = 0;
  for (const [name, meta] of orgSecrets) {
    const refs = secretUsage.get(name) || [];
    const repoCount = new Set(refs.map((x) => x.repo)).size;
    if (repoCount > 0) usedCount++;
    else orphaned.push(name);
    orgSecretsReport[name] = {
      visibility: meta.visibility,
      updated_at: meta.updated_at,
      repo_count: repoCount,
      reference_count: refs.length,
      references: refs,
    };
  }
  orphaned.sort();

  return {
    org,
    scanned_at: new Date().toISOString(),
    totals: {
      repos_scanned: repoResults.filter(Boolean).length,
      secrets_total: orgSecrets.size,
      secrets_used: usedCount,
      secrets_orphaned: orphaned.length,
      repos_inheriting_all: inheritReposCount,
    },
    org_secrets: orgSecretsReport,
    orphaned_secrets: orphaned,
    repos,
  };
}

function writeMarkdownSummary(report) {
  const t = report.totals;
  const lines = [];
  lines.push(`## Org Secret Usage Scan — \`${report.org}\``);
  lines.push("");
  lines.push(`- Repositories scanned: **${t.repos_scanned}**`);
  lines.push(`- Org secrets total: **${t.secrets_total}**`);
  lines.push(`- Referenced by ≥1 repo: **${t.secrets_used}**`);
  lines.push(`- Orphaned (referenced by none): **${t.secrets_orphaned}**`);
  lines.push(`- Repos using \`secrets: inherit\`: **${t.repos_inheriting_all}**`);
  lines.push("");

  if (t.repos_inheriting_all > 0) {
    lines.push(
      `> ⚠️ ${t.repos_inheriting_all} repo(s) use \`secrets: inherit\`, which implicitly ` +
        `passes **all** org secrets to a called workflow. Orphan detection cannot ` +
        `see through these — treat orphans as candidates, not certainties.`
    );
    lines.push("");
  }

  lines.push("### Org secrets");
  lines.push("");
  lines.push("| Secret | Visibility | Repos | Refs | Status |");
  lines.push("|---|---|---:|---:|---|");
  const names = Object.keys(report.org_secrets).sort();
  for (const name of names) {
    const s = report.org_secrets[name];
    const status = s.repo_count === 0 ? "🟠 orphaned" : "🟢 used";
    lines.push(
      `| \`${name}\` | ${s.visibility} | ${s.repo_count} | ${s.reference_count} | ${status} |`
    );
  }
  lines.push("");

  if (report.orphaned_secrets.length > 0) {
    lines.push("### 🟠 Orphaned secrets (cleanup candidates)");
    lines.push("");
    for (const name of report.orphaned_secrets) lines.push(`- \`${name}\``);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  const token = core.getInput("token", { required: true });
  const owner = core.getInput("owner") || github.context.repo.owner;
  const namePattern = core.getInput("name_pattern") || "*";
  const visibility = (core.getInput("repo_visibility") || "all").toLowerCase();
  const includeArchived = core.getInput("include_archived") === "true";
  const failOnOrphans = core.getInput("fail_on_orphans") === "true";
  const outputDir = core.getInput("output_dir") || "org-secret-scan";

  const octokit = github.getOctokit(token);

  core.info(`Listing organization secrets for ${owner}...`);
  let orgSecrets;
  try {
    orgSecrets = await listOrgSecrets(octokit, owner);
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      throw new Error(
        `Cannot list org secrets for ${owner} (HTTP ${err.status}). ` +
          `The token needs organization secrets read access (PAT with admin:org, ` +
          `or a GitHub App with "Organization secrets: read-only"). ` +
          `The default GITHUB_TOKEN does NOT have this.`
      );
    }
    throw err;
  }
  core.info(`Found ${orgSecrets.size} org-level secret(s).`);
  const orgSecretNames = new Set(orgSecrets.keys());

  core.info(`Listing repositories (visibility=${visibility}, pattern=${namePattern})...`);
  const repos = await listRepos(
    octokit,
    owner,
    visibility,
    includeArchived,
    namePattern
  );
  core.info(`Scanning ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}...`);

  const repoResults = await mapPool(repos, CONCURRENCY, async (repo) => {
    try {
      const r = await scanRepo(octokit, owner, repo, orgSecretNames);
      core.info(
        `[${repo.name}] ${r.files_scanned} file(s), ` +
          `${r.org_secrets_used.size} org secret(s) used` +
          (r.inherits.length ? `, inherits all` : "")
      );
      return r;
    } catch (err) {
      core.warning(`[${repo.name}] scan failed: ${err.message}`);
      return null;
    }
  });

  const report = buildReport(owner, orgSecrets, repoResults);

  fs.mkdirSync(outputDir, { recursive: true });
  const reportFile = path.join(outputDir, "org-secret-scan.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const summary = writeMarkdownSummary(report);
  fs.writeFileSync(path.join(outputDir, "summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }

  core.setOutput("output_dir", outputDir);
  core.setOutput("report_file", reportFile);
  core.setOutput("secrets_total", String(report.totals.secrets_total));
  core.setOutput("secrets_used", String(report.totals.secrets_used));
  core.setOutput("secrets_orphaned", String(report.totals.secrets_orphaned));

  core.info(
    `Done. total=${report.totals.secrets_total} ` +
      `used=${report.totals.secrets_used} ` +
      `orphaned=${report.totals.secrets_orphaned}`
  );

  if (failOnOrphans && report.totals.secrets_orphaned > 0) {
    core.setFailed(
      `${report.totals.secrets_orphaned} org secret(s) referenced by no repository: ` +
        report.orphaned_secrets.join(", ")
    );
  }
}

run().catch((err) => {
  core.setFailed(err.message);
});
