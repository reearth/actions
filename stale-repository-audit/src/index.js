const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");
const { minimatch } = require("minimatch");
const yaml = require("js-yaml");

// Accepts: JSON string, YAML string, or path to a .yml/.yaml file.
// YAML file format:
//   users:
//     - github: alice
//       slack: UXXXXXXXX
function parseSlackUserMap(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed || trimmed === "{}") return {};

  // File path input
  if (/\.(ya?ml)$/i.test(trimmed)) {
    const content = fs.readFileSync(trimmed, "utf8");
    const parsed = yaml.load(content);
    return buildMapFromYamlDoc(parsed, trimmed);
  }

  // Inline JSON
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  // Inline YAML
  const parsed = yaml.load(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !parsed.users) {
    // Plain key:value map  { alice: UXXXXXXXX }
    return parsed;
  }
  return buildMapFromYamlDoc(parsed, "<inline>");
}

function buildMapFromYamlDoc(doc, source) {
  if (!doc || !Array.isArray(doc.users)) {
    throw new Error(`slack_user_map: expected 'users' list in ${source}`);
  }
  return Object.fromEntries(
    doc.users.map((entry) => {
      if (!entry.github || !entry.slack) {
        throw new Error(`slack_user_map: each entry must have 'github' and 'slack' keys`);
      }
      return [entry.github, entry.slack];
    })
  );
}

const CONCURRENCY = 10;
const STALENESS_ISSUE_TITLE = "Staleness review: action required";
const API_HEADERS = { "x-github-api-version": "2026-03-10" };

// ─── Staleness checks ────────────────────────────────────────────────────────

async function getLastWorkflowRun(octokit, owner, repo) {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 1,
      status: "completed",
      headers: API_HEADERS,
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
      headers: API_HEADERS,
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
      { owner, repo, headers: API_HEADERS }
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

async function setCustomProperty(octokit, owner, repo, propertyName, value, dryRun) {
  if (dryRun) {
    core.info(`[${repo}] DRY-RUN: Would set custom property ${propertyName}=${value}`);
    return;
  }
  await octokit.request("PATCH /repos/{owner}/{repo}/properties/values", {
    owner,
    repo,
    properties: [{ property_name: propertyName, value }],
    headers: API_HEADERS,
  });
}

// ─── Ownership resolution ─────────────────────────────────────────────────────

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
          headers: { accept: "application/vnd.github.raw+json", ...API_HEADERS },
        }
      );
      const content = typeof data === "string" ? data : "";
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
      // not found at this location
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
      { owner, repo, since: since.toISOString(), per_page: 100, headers: API_HEADERS },
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
    const { data } = await octokit.rest.repos.listCommits({ owner, repo, per_page: 1, headers: API_HEADERS });
    const lastPage = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo,
      per_page: 1,
      headers: API_HEADERS,
    });
    const linkHeader = lastPage.headers?.link || "";
    const lastPageMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
    if (lastPageMatch) {
      const { data: firstCommits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: 1,
        page: parseInt(lastPageMatch[1], 10),
        headers: API_HEADERS,
      });
      return firstCommits[0]?.author?.login || null;
    }
    return data[data.length - 1]?.author?.login || null;
  } catch {
    return null;
  }
}

async function resolveOwner(octokit, orgLogin, repoName, customProperties, leadershipTeam) {
  if (customProperties["owner"]) {
    return { owner: customProperties["owner"], source: "custom_property" };
  }
  const readmeOwner = await getOwnerFromReadme(octokit, orgLogin, repoName);
  if (readmeOwner) return { owner: readmeOwner, source: "readme" };

  const topCommitter = await getTopCommitter(octokit, orgLogin, repoName, 365);
  if (topCommitter) return { owner: topCommitter, source: "top_committer" };

  const creator = await getRepoCreator(octokit, orgLogin, repoName);
  if (creator) return { owner: creator, source: "repo_creator" };

  return { owner: leadershipTeam || null, source: "orphan", orphan: true };
}

// ─── Issue management ─────────────────────────────────────────────────────────

function buildIssueBody(repoFullName, resolvedOwner, responseWindowDays) {
  const deadline = new Date();
  deadline.setDate(deadline.getDate() + responseWindowDays);
  const deadlineStr = deadline.toISOString().split("T")[0];

  return `## Staleness Review Required

This repository has been flagged as potentially stale. No significant activity has been detected in the past 12 months.

**Resolved owner:** @${resolvedOwner || "unknown"}
**Response deadline:** ${deadlineStr} (${responseWindowDays} days from today)

---

To keep this repository active, please reply to this issue answering the following questions:

1. **Purpose** — What is this repository for? Who uses it?
2. **Maintenance plan** — Is it actively maintained? What is the cadence?
3. **Justification** — Why should it remain active rather than be archived?

> If no response is received by the deadline, this repository will be automatically archived.
> Archival is not deletion — the repository remains visible, forkable, and searchable, but becomes read-only.
> To restore an archived repository, submit a new maintenance plan.

---

*This issue was opened automatically by the [stale-repository-audit](https://github.com/${repoFullName.split("/")[0]}/.github) action.*`;
}

async function findExistingReviewIssue(octokit, owner, repo) {
  try {
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: "open",
      per_page: 100,
      headers: API_HEADERS,
    });
    return issues.find((i) => i.title === STALENESS_ISSUE_TITLE) || null;
  } catch {
    return null;
  }
}

async function openReviewIssue(octokit, orgLogin, repoName, repoFullName, resolvedOwner, responseWindowDays, dryRun) {
  const existing = await findExistingReviewIssue(octokit, orgLogin, repoName);
  if (existing) {
    core.info(`[${repoName}] Review issue already open: ${existing.html_url}`);
    return { issue: existing, created: false };
  }

  const body = buildIssueBody(repoFullName, resolvedOwner, responseWindowDays);

  if (dryRun) {
    core.info(`[${repoName}] DRY-RUN: Would open issue "${STALENESS_ISSUE_TITLE}"`);
    return { issue: null, created: false, issuesDisabled: false };
  }

  try {
    const { data: issue } = await octokit.rest.issues.create({
      owner: orgLogin,
      repo: repoName,
      title: STALENESS_ISSUE_TITLE,
      body,
      labels: ["stale", "action-required"],
      headers: API_HEADERS,
    });
    core.info(`[${repoName}] Opened review issue: ${issue.html_url}`);
    return { issue, created: true, issuesDisabled: false };
  } catch (err) {
    if (err.status === 410 || /issues has been disabled/i.test(err.message)) {
      core.warning(`[${repoName}] Issues are disabled — skipping issue creation`);
      return { issue: null, created: false, issuesDisabled: true };
    }
    throw err;
  }
}

// Returns true if the issue has a non-bot comment (owner responded)
async function issueHasOwnerResponse(octokit, orgLogin, repoName, issue) {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: orgLogin,
      repo: repoName,
      issue_number: issue.number,
      per_page: 100,
      headers: API_HEADERS,
    });
    // Any comment from a non-bot human counts as a response
    return comments.some((c) => c.user?.type !== "Bot");
  } catch {
    return false;
  }
}

// ─── Slack notifications ──────────────────────────────────────────────────────

async function resolveSlackUserId(slackToken, githubLogin, slackUserMap) {
  if (slackUserMap[githubLogin]) return slackUserMap[githubLogin];

  // Attempt lookup by display name via users.list (best-effort)
  try {
    const resp = await fetch("https://slack.com/api/users.list", {
      headers: { Authorization: `Bearer ${slackToken}` },
    });
    const body = await resp.json();
    if (!body.ok) return null;
    const member = body.members?.find(
      (m) =>
        m.name === githubLogin ||
        m.profile?.display_name === githubLogin ||
        m.profile?.display_name_normalized === githubLogin
    );
    return member?.id || null;
  } catch {
    return null;
  }
}

async function sendSlackDm(slackToken, slackUserId, message, dryRun) {
  if (dryRun) {
    core.info(`DRY-RUN: Would send Slack DM to ${slackUserId}: ${message}`);
    return true;
  }
  try {
    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: slackUserId, text: message }),
    });
    const body = await resp.json();
    if (!body.ok) {
      core.warning(`Slack DM failed for ${slackUserId}: ${body.error}`);
      return false;
    }
    return true;
  } catch (err) {
    core.warning(`Slack DM error for ${slackUserId}: ${err.message}`);
    return false;
  }
}

function buildSlackMessage(repoFullName, issueUrl, responseWindowDays) {
  return (
    `:warning: *Staleness review required* for \`${repoFullName}\`\n\n` +
    `This repository has had no significant activity in over 12 months and has been flagged for review.\n\n` +
    `Please respond to the issue within *${responseWindowDays} days* to keep the repository active:\n` +
    `${issueUrl}\n\n` +
    `If there is no response by the deadline, the repository will be automatically archived (read-only, not deleted).`
  );
}

function buildSlackMessageNoIssue(repoFullName, responseWindowDays) {
  return (
    `:warning: *Staleness review required* for \`${repoFullName}\`\n\n` +
    `This repository has had no significant activity in over 12 months and has been flagged for review.\n` +
    `Issues are disabled on this repository, so no review issue could be opened.\n\n` +
    `Please review the repository within *${responseWindowDays} days* and either re-enable issues and respond to the staleness review, ` +
    `or confirm it should be archived: https://github.com/${repoFullName}\n\n` +
    `If there is no action by the deadline, the repository will be automatically archived (read-only, not deleted).`
  );
}

// ─── Archive behavior ─────────────────────────────────────────────────────────

async function prependArchivedBadge(octokit, orgLogin, repoName, reason, dryRun) {
  const readmeFiles = ["README.md", "readme.md", "README"];
  for (const file of readmeFiles) {
    try {
      const { data: fileData } = await octokit.rest.repos.getContent({
        owner: orgLogin,
        repo: repoName,
        path: file,
        headers: API_HEADERS,
      });

      if (Array.isArray(fileData)) continue; // directory, skip

      const currentContent = Buffer.from(fileData.content, "base64").toString("utf8");
      const archivalDate = new Date().toISOString().split("T")[0];
      const badge = `> ⚠️ **Archived** on ${archivalDate}. Reason: \`${reason}\`. This repository is read-only. To restore it, submit a new maintenance plan.\n\n`;

      if (currentContent.startsWith("> ⚠️ **Archived**")) {
        core.info(`[${repoName}] README already has archived badge — skipping prepend`);
        return;
      }

      const newContent = badge + currentContent;

      if (dryRun) {
        core.info(`[${repoName}] DRY-RUN: Would prepend archived badge to ${file}`);
        return;
      }

      await octokit.rest.repos.createOrUpdateFileContents({
        owner: orgLogin,
        repo: repoName,
        path: file,
        message: "chore: mark repository as archived [skip ci]",
        content: Buffer.from(newContent).toString("base64"),
        sha: fileData.sha,
        headers: API_HEADERS,
      });

      core.info(`[${repoName}] Prepended archived badge to ${file}`);
      return;
    } catch {
      // file not found, try next
    }
  }
  core.info(`[${repoName}] No README found — skipping badge prepend`);
}

async function archiveRepo(octokit, orgLogin, repoName, reason, dryRun) {
  if (dryRun) {
    core.info(`[${repoName}] DRY-RUN: Would archive repository (reason=${reason})`);
    return;
  }

  await Promise.all([
    octokit.rest.repos.update({ owner: orgLogin, repo: repoName, archived: true, headers: API_HEADERS }),
    setCustomProperty(octokit, orgLogin, repoName, "archived_reason", reason, false),
    setCustomProperty(octokit, orgLogin, repoName, "status", "archived", false),
    prependArchivedBadge(octokit, orgLogin, repoName, reason, false),
  ]);

  core.info(`[${repoName}] Archived (reason=${reason})`);
}

// ─── Per-repo scan ────────────────────────────────────────────────────────────

async function auditRepo(octokit, orgLogin, repo, opts) {
  const { pushedAtThresholdMs, workflowRunThresholdMs, leadershipTeam } = opts;
  const repoName = repo.name;

  if (repo.archived) {
    core.info(`[${repoName}] Skipping — already archived`);
    return null;
  }

  const now = Date.now();
  const pushedAt = repo.pushed_at ? new Date(repo.pushed_at).getTime() : 0;

  if (now - pushedAt <= pushedAtThresholdMs) {
    core.info(`[${repoName}] Active (pushed recently) — skipping`);
    return null;
  }

  const customProperties = await getCustomProperties(octokit, orgLogin, repoName);
  if (customProperties["retention"] === "permanent") {
    core.info(`[${repoName}] Skipping — retention=permanent`);
    return null;
  }

  let workflowStale = null;
  const repoHasWorkflows = await hasWorkflows(octokit, orgLogin, repoName);
  if (repoHasWorkflows) {
    const lastRun = await getLastWorkflowRun(octokit, orgLogin, repoName);
    workflowStale = lastRun === null || now - lastRun.getTime() > workflowRunThresholdMs;
    if (!workflowStale) {
      core.info(`[${repoName}] Has recent workflow run — skipping`);
      return null;
    }
  }

  core.info(`[${repoName}] STALE — resolving owner...`);
  const ownerInfo = await resolveOwner(octokit, orgLogin, repoName, customProperties, leadershipTeam);

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

// ─── Modes ────────────────────────────────────────────────────────────────────

async function runScan(octokit, staleRepos, opts) {
  const { orgLogin, responseWindowDays, slackToken, slackUserMap, dryRun } = opts;
  const results = [];

  for (let i = 0; i < staleRepos.length; i += CONCURRENCY) {
    const batch = staleRepos.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const { repo: repoName, full_name, resolved_owner, orphan } = entry;

        // Open issue
        const { issue, issuesDisabled } = await openReviewIssue(
          octokit,
          orgLogin,
          repoName,
          full_name,
          resolved_owner,
          responseWindowDays,
          dryRun
        );

        // When issues are disabled we still send a Slack DM pointing at the repo
        // directly, so the owner can decide what to do. There's no issue URL to link.
        const issueUrl = issue?.html_url ?? (issuesDisabled ? `https://github.com/${full_name}` : null);

        // Slack DM
        let slackSent = false;
        if (slackToken && resolved_owner) {
          const slackUserId = await resolveSlackUserId(slackToken, resolved_owner, slackUserMap);
          if (slackUserId) {
            const message = issuesDisabled
              ? buildSlackMessageNoIssue(full_name, responseWindowDays)
              : buildSlackMessage(full_name, issueUrl, responseWindowDays);
            slackSent = await sendSlackDm(slackToken, slackUserId, message, dryRun);
          } else {
            core.warning(`[${repoName}] Could not resolve Slack user ID for GitHub login: ${resolved_owner}`);
          }
        }

        // Orphan repos are the strongest archive candidates — archive immediately
        if (orphan) {
          core.info(`[${repoName}] Orphan repo — archiving immediately`);
          await archiveRepo(octokit, orgLogin, repoName, "orphan", dryRun);
          return { ...entry, issue_url: issueUrl, issues_disabled: issuesDisabled, issue_created: created, slack_sent: slackSent, archived: true, archive_reason: "orphan" };
        }

        return { ...entry, issue_url: issueUrl, issues_disabled: issuesDisabled, issue_created: created, slack_sent: slackSent, archived: false };
      })
    );
    results.push(...batchResults);
  }

  return results;
}

async function runArchive(octokit, staleRepos, opts) {
  const { orgLogin, responseWindowDays, dryRun } = opts;
  const responseWindowMs = responseWindowDays * 24 * 60 * 60 * 1000;
  const archived = [];

  for (let i = 0; i < staleRepos.length; i += CONCURRENCY) {
    const batch = staleRepos.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        const { repo: repoName } = entry;

        // Skip already-archived entries (orphans handled in scan)
        if (entry.archived) return;

        // findExistingReviewIssue returns null both when issues are disabled
        // and when no staleness issue was ever opened. Either way, there is
        // nothing to evaluate — skip without archiving.
        const issue = await findExistingReviewIssue(octokit, orgLogin, repoName);
        if (!issue) {
          const reason = entry.issues_disabled ? "issues are disabled on this repo" : "no open review issue found";
          core.info(`[${repoName}] Skipping archive check — ${reason}`);
          return;
        }

        // In full mode the scan phase just opened this issue moments ago.
        // Skip it so we don't immediately archive before the owner can respond.
        if (entry.issue_created) {
          core.info(`[${repoName}] Issue was just created this run — skipping archive until next run`);
          return;
        }

        const issueAge = Date.now() - new Date(issue.created_at).getTime();
        if (issueAge < responseWindowMs) {
          const daysLeft = Math.ceil((responseWindowMs - issueAge) / (1000 * 60 * 60 * 24));
          core.info(`[${repoName}] Review window still open (${daysLeft} days left) — skipping`);
          return;
        }

        const hasResponse = await issueHasOwnerResponse(octokit, orgLogin, repoName, issue);
        if (hasResponse) {
          core.info(`[${repoName}] Owner responded — resetting staleness clock (closing issue)`);
          if (!dryRun) {
            await octokit.rest.issues.createComment({
              owner: orgLogin,
              repo: repoName,
              issue_number: issue.number,
              body: "Thank you for responding. The staleness clock has been reset for another 12 months. This issue will now be closed.",
              headers: API_HEADERS,
            });
            await octokit.rest.issues.update({
              owner: orgLogin,
              repo: repoName,
              issue_number: issue.number,
              state: "closed",
              headers: API_HEADERS,
            });
          } else {
            core.info(`[${repoName}] DRY-RUN: Would close issue and reset staleness clock`);
          }
          return;
        }

        core.info(`[${repoName}] Review window expired with no response — archiving`);
        await archiveRepo(octokit, orgLogin, repoName, "auto_staleness", dryRun);
        archived.push({ ...entry, archived: true, archive_reason: "auto_staleness" });
      })
    );
  }

  return archived;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run() {
  const token = core.getInput("token", { required: true });
  const orgLogin = core.getInput("owner") || github.context.repo.owner;
  const namePattern = core.getInput("name_pattern") || "*";
  const pushedAtThresholdDays = parseInt(core.getInput("pushed_at_threshold_days") || "365", 10);
  const workflowRunThresholdDays = parseInt(core.getInput("workflow_run_threshold_days") || "180", 10);
  const responseWindowDays = parseInt(core.getInput("response_window_days") || "14", 10);
  const slackToken = core.getInput("slack_token") || "";
  const slackUserMap = parseSlackUserMap(core.getInput("slack_user_map"));
  const mode = core.getInput("mode") || "scan";
  const dryRun = core.getInput("dry_run") === "true";
  const outputDir = core.getInput("output_dir") || "stale-audit";
  const leadershipTeam = core.getInput("engineering_leadership_team") || null;

  const pushedAtThresholdMs = pushedAtThresholdDays * 24 * 60 * 60 * 1000;
  const workflowRunThresholdMs = workflowRunThresholdDays * 24 * 60 * 60 * 1000;

  if (dryRun) core.info("DRY-RUN mode enabled — no issues, Slack messages, or archives will be created.");
  core.info(`Mode: ${mode}`);

  const octokit = github.getOctokit(token);
  fs.mkdirSync(outputDir, { recursive: true });

  core.info(`Listing repositories for org: ${orgLogin} (pattern: ${namePattern})...`);
  const allRepos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: orgLogin,
    per_page: 100,
    type: "all",
    headers: API_HEADERS,
  });

  const repos = namePattern === "*"
    ? allRepos
    : allRepos.filter((r) => minimatch(r.name, namePattern));

  core.info(`Found ${repos.length} matching repositories (${allRepos.length} total). Auditing with concurrency=${CONCURRENCY}...`);

  // Detect stale repos
  const staleRepos = [];
  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((repo) =>
        auditRepo(octokit, orgLogin, repo, { pushedAtThresholdMs, workflowRunThresholdMs, leadershipTeam })
      )
    );
    for (const r of results) {
      if (r !== null) staleRepos.push(r);
    }
  }

  // Sort: orphans first, then by days_since_push desc
  staleRepos.sort((a, b) => {
    if (a.orphan !== b.orphan) return a.orphan ? -1 : 1;
    return b.days_since_push - a.days_since_push;
  });

  core.info(`\nAudit complete. ${staleRepos.length} stale repositories found.`);

  const scanOpts = { orgLogin, responseWindowDays, slackToken, slackUserMap, dryRun };

  let scanResults = staleRepos.map((r) => ({ ...r }));
  let archivedCount = 0;

  if (mode === "scan" || mode === "full") {
    scanResults = await runScan(octokit, staleRepos, scanOpts);
    archivedCount += scanResults.filter((r) => r.archived).length;
  }

  if (mode === "archive" || mode === "full") {
    const archiveList = mode === "full" ? scanResults : staleRepos;
    const newlyArchived = await runArchive(octokit, archiveList, { orgLogin, responseWindowDays, dryRun });
    archivedCount += newlyArchived.length;
    // Merge archive results back
    for (const a of newlyArchived) {
      const idx = scanResults.findIndex((r) => r.repo === a.repo);
      if (idx !== -1) scanResults[idx] = a;
    }
  }

  // Write report
  const report = {
    generated_at: new Date().toISOString(),
    org: orgLogin,
    name_pattern: namePattern,
    mode,
    dry_run: dryRun,
    thresholds: {
      pushed_at_days: pushedAtThresholdDays,
      workflow_run_days: workflowRunThresholdDays,
      response_window_days: responseWindowDays,
    },
    summary: {
      total_scanned: repos.length,
      stale_count: staleRepos.length,
      orphan_count: staleRepos.filter((r) => r.orphan).length,
      archived_count: archivedCount,
    },
    stale_repositories: scanResults,
  };

  const reportFile = path.join(outputDir, "stale-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

  const summaryLines = [
    `# Stale Repository Audit`,
    ``,
    `**Organization:** ${orgLogin}  `,
    `**Generated:** ${report.generated_at}  `,
    `**Pattern:** \`${namePattern}\`  `,
    `**Mode:** ${mode}${dryRun ? " *(dry-run)*" : ""}`,
    ``,
    `## Summary`,
    ``,
    `| | Count |`,
    `|---|---|`,
    `| Repos scanned | ${repos.length} |`,
    `| Stale repos | ${staleRepos.length} |`,
    `| Orphan repos | ${report.summary.orphan_count} |`,
    `| Archived this run | ${archivedCount} |`,
    ``,
    `## Stale Repositories`,
    ``,
    `| Repository | Days Since Push | Owner | Owner Source | Orphan | Archived | Issue |`,
    `|---|---|---|---|---|---|---|`,
    ...scanResults.map((r) => {
      const issueCell = r.issue_url ? `[open](${r.issue_url})` : "—";
      return `| [${r.repo}](https://github.com/${r.full_name}) | ${r.days_since_push} | ${r.resolved_owner || "—"} | ${r.owner_source} | ${r.orphan ? "**YES**" : "no"} | ${r.archived ? `**YES** (${r.archive_reason})` : "no"} | ${issueCell} |`;
    }),
  ];

  const summaryFile = path.join(outputDir, "stale-report.md");
  fs.writeFileSync(summaryFile, summaryLines.join("\n") + "\n");

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryLines.join("\n") + "\n");
  }

  core.setOutput("output_dir", outputDir);
  core.setOutput("stale_count", String(staleRepos.length));
  core.setOutput("archived_count", String(archivedCount));
  core.setOutput("report_file", reportFile);

  core.info(`Report: ${reportFile}`);
  core.info(`Summary: ${summaryFile}`);
}

run().catch((err) => {
  core.setFailed(err.message);
});
