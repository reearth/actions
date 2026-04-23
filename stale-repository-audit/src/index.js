const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const { minimatch } = require("minimatch");

const CONCURRENCY = 10;
const API_HEADERS = {
  "x-github-api-version": "2022-11-28",
};

// --- Staleness checks ---

async function getLastWorkflowRun(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 1,
      status: "completed",
    });
    if (data.workflow_runs.length === 0) return null;
    return new Date(data.workflow_runs[0].created_at);
  } catch {
    return null;
  }
}

async function hasWorkflows(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.actions.listRepoWorkflows({
      owner,
      repo,
      per_page: 1,
    });
    return data.total_count > 0;
  } catch {
    return false;
  }
}

async function getCustomProperties(octokit, owner, repo) {
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/properties/values",
      {
        owner,
        repo,
        headers: API_HEADERS,
      }
    );
    const props = {};
    for (const { property_name, value } of data) {
      props[property_name] = value;
    }
    return props;
  } catch {
    return {};
  }
}

// --- Ownership resolution ---

async function getOwnerFromCustomProperty(customProperties) {
  return customProperties["owner"] || null;
}

async function getOwnerFromReadme(octokit, owner, repo) {
  const readmeFiles = ["README.md", "readme.md", "README.MD", "README"];
  for (const file of readmeFiles) {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner,
          repo,
          path: file,
          headers: {
            accept: "application/vnd.github.raw+json",
            ...API_HEADERS,
          },
        }
      );
      const content = typeof data === "string" ? data : "";
      // Look for patterns like "Owner: @username", "Maintainer: @username", "owner: username"
      const patterns = [
        /(?:owner|maintainer|maintained by)[:\s]+@?([\w-]+)/i,
        /^#+\s*owner[:\s]+@?([\w-]+)/im,
      ];
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) return match[1];
      }
      return null;
    } catch {
      // not found, try next
    }
  }
  return null;
}

async function getTopCommitter(octokit, owner, repo, sinceDays) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  try {
    const commits = await octokit.paginate(
      octokit.rest.repos.listCommits,
      {
        owner,
        repo,
        since: since.toISOString(),
        per_page: 100,
      },
      (response) => response.data
    );

    const counts = {};
    for (const commit of commits) {
      const login = commit.author?.login;
      if (login) counts[login] = (counts[login] || 0) + 1;
    }

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : null;
  } catch {
    return null;
  }
}

async function getRepoCreator(octokit, owner, repo) {
  try {
    // The repo list endpoint includes the owner which is the org, not creator.
    // Use commit history to find the earliest committer as a proxy for creator.
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      per_page: 1,
    });
    // The last commit in forward order is hard to get; use the repo creation via events is unreliable.
    // Fall back: list commits and get the last page for the first commit.
    const lastPage = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      per_page: 1,
      headers: {
        ...API_HEADERS,
      },
    });

    // Check Link header for last page
    const linkHeader = lastPage.headers?.link || "";
    const lastPageMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
    if (lastPageMatch) {
      const lastPageNum = parseInt(lastPageMatch[1], 10);
      const { data: firstCommits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 1,
        page: lastPageNum,
      });
      return firstCommits[0]?.author?.login || null;
    }

    // Only one page of commits
    return data[data.length - 1]?.author?.login || null;
  } catch {
    return null;
  }
}

async function resolveOwner(octokit, owner, repo, customProperties, leadershipTeam) {
  // Priority 1: custom property "owner"
  const propOwner = await getOwnerFromCustomProperty(customProperties);
  if (propOwner) {
    return { owner: propOwner, source: "custom_property" };
  }

  // Priority 2: README
  const readmeOwner = await getOwnerFromReadme(octokit, owner, repo);
  if (readmeOwner) {
    return { owner: readmeOwner, source: "readme" };
  }

  // Priority 3: top committer in last 12 months
  const topCommitter = await getTopCommitter(octokit, owner, repo, 365);
  if (topCommitter) {
    return { owner: topCommitter, source: "top_committer" };
  }

  // Priority 4: repository creator
  const creator = await getRepoCreator(octokit, owner, repo);
  if (creator) {
    return { owner: creator, source: "repo_creator" };
  }

  // Priority 5: fallback to engineering leadership / orphan
  const fallback = leadershipTeam || null;
  return {
    owner: fallback,
    source: "orphan",
    orphan: true,
  };
}

// --- Core audit logic ---

async function auditRepo(octokit, orgLogin, repo, opts) {
  const { pushedAtThresholdMs, workflowRunThresholdMs, leadershipTeam } = opts;
  const repoName = repo.name;

  // Skip archived repos
  if (repo.archived) {
    core.info(`[${repoName}] Skipping — already archived`);
    return null;
  }

  const now = Date.now();
  const pushedAt = repo.pushed_at ? new Date(repo.pushed_at).getTime() : 0;
  const pushedTooOld = now - pushedAt > pushedAtThresholdMs;

  if (!pushedTooOld) {
    core.info(`[${repoName}] Active (pushed recently) — skipping`);
    return null;
  }

  // Check custom properties (retention=permanent skips)
  const customProperties = await getCustomProperties(octokit, orgLogin, repoName);
  if (customProperties["retention"] === "permanent") {
    core.info(`[${repoName}] Skipping — retention=permanent`);
    return null;
  }

  // Check workflow runs (only if workflows exist)
  let workflowStale = null;
  const repoHasWorkflows = await hasWorkflows(octokit, orgLogin, repoName);
  if (repoHasWorkflows) {
    const lastRun = await getLastWorkflowRun(octokit, orgLogin, repoName);
    if (lastRun === null) {
      workflowStale = true; // has workflows but no completed runs ever
    } else {
      workflowStale = now - lastRun.getTime() > workflowRunThresholdMs;
    }

    if (!workflowStale) {
      core.info(`[${repoName}] Has recent workflow run — skipping`);
      return null;
    }
  }

  core.info(`[${repoName}] STALE — resolving owner...`);

  const ownerInfo = await resolveOwner(
    octokit,
    orgLogin,
    repoName,
    customProperties,
    leadershipTeam
  );

  return {
    repo: repoName,
    full_name: repo.full_name,
    description: repo.description || "",
    pushed_at: repo.pushed_at,
    days_since_push: Math.floor((now - pushedAt) / (1000 * 60 * 60 * 24)),
    has_workflows: repoHasWorkflows,
    workflow_stale: workflowStale,
    custom_properties: customProperties,
    resolved_owner: ownerInfo.owner,
    owner_source: ownerInfo.source,
    orphan: ownerInfo.orphan || false,
  };
}

async function run() {
  const token = core.getInput("token", { required: true });
  const orgLogin = core.getInput("owner") || github.context.repo.owner;
  const namePattern = core.getInput("name_pattern") || "*";
  const pushedAtThresholdDays = parseInt(core.getInput("pushed_at_threshold_days") || "365", 10);
  const workflowRunThresholdDays = parseInt(core.getInput("workflow_run_threshold_days") || "180", 10);
  const outputDir = core.getInput("output_dir") || "stale-audit";
  const leadershipTeam = core.getInput("engineering_leadership_team") || null;

  const pushedAtThresholdMs = pushedAtThresholdDays * 24 * 60 * 60 * 1000;
  const workflowRunThresholdMs = workflowRunThresholdDays * 24 * 60 * 60 * 1000;

  const octokit = github.getOctokit(token);

  fs.mkdirSync(outputDir, { recursive: true });

  core.info(`Listing repositories for org: ${orgLogin} (pattern: ${namePattern})...`);

  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: orgLogin,
    per_page: 100,
    type: "all",
  });

  const repos = namePattern === "*"
    ? allRepos
    : allRepos.filter((r) => minimatch(r.name, namePattern));

  core.info(`Found ${repos.length} matching repositories (${allRepos.length} total). Auditing with concurrency=${CONCURRENCY}...`);

  const staleRepos = [];

  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((repo) =>
        auditRepo(octokit, orgLogin, repo, {
          pushedAtThresholdMs,
          workflowRunThresholdMs,
          leadershipTeam,
        })
      )
    );
    for (const result of results) {
      if (result !== null) staleRepos.push(result);
    }
  }

  core.info(`\nAudit complete. ${staleRepos.length} stale repositories found.`);

  // Sort: orphans first, then by days_since_push desc
  staleRepos.sort((a, b) => {
    if (a.orphan !== b.orphan) return a.orphan ? -1 : 1;
    return b.days_since_push - a.days_since_push;
  });

  const report = {
    generated_at: new Date().toISOString(),
    org: orgLogin,
    name_pattern: namePattern,
    thresholds: {
      pushed_at_days: pushedAtThresholdDays,
      workflow_run_days: workflowRunThresholdDays,
    },
    summary: {
      total_scanned: repos.length,
      stale_count: staleRepos.length,
      orphan_count: staleRepos.filter((r) => r.orphan).length,
    },
    stale_repositories: staleRepos,
  };

  const reportFile = path.join(outputDir, "stale-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  // Write a human-readable summary
  const summaryLines = [
    `# Stale Repository Audit`,
    ``,
    `**Organization:** ${orgLogin}`,
    `**Generated:** ${report.generated_at}`,
    `**Pattern:** \`${namePattern}\``,
    ``,
    `## Summary`,
    ``,
    `| | Count |`,
    `|---|---|`,
    `| Repos scanned | ${repos.length} |`,
    `| Stale repos | ${staleRepos.length} |`,
    `| Orphan repos | ${report.summary.orphan_count} |`,
    ``,
    `## Stale Repositories`,
    ``,
    `| Repository | Days Since Push | Has Workflows | Owner | Owner Source | Orphan |`,
    `|---|---|---|---|---|---|`,
    ...staleRepos.map(
      (r) =>
        `| [${r.repo}](https://github.com/${r.full_name}) | ${r.days_since_push} | ${r.has_workflows ? "yes" : "no"} | ${r.resolved_owner || "—"} | ${r.owner_source} | ${r.orphan ? "**YES**" : "no"} |`
    ),
  ];

  const summaryFile = path.join(outputDir, "stale-report.md");
  fs.writeFileSync(summaryFile, summaryLines.join("\n") + "\n");

  // Write to GitHub Actions step summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n") + "\n");
  }

  core.setOutput("output_dir", outputDir);
  core.setOutput("stale_count", String(staleRepos.length));
  core.setOutput("report_file", reportFile);

  core.info(`Report written to ${reportFile}`);
  core.info(`Summary written to ${summaryFile}`);
}

run().catch((err) => {
  core.setFailed(err.message);
});
