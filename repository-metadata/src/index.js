const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");

const CODEOWNERS_LOCATIONS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
const CONCURRENCY = 10;

async function getCodeowners(octokit, owner, repo) {
  for (const location of CODEOWNERS_LOCATIONS) {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: location,
        headers: {
          accept: "application/vnd.github.raw+json",
          "x-github-api-version": "2026-03-10",
        },
      });
      return { content: data, location };
    } catch {
      // not found at this location, try next
    }
  }
  return { content: "", location: null };
}

async function getMaintainers(octokit, owner, repo) {
  try {
    const collaborators = await octokit.paginate(octokit.rest.repos.listCollaborators, {
      owner,
      repo,
      per_page: 100,
    });

    const privileged = collaborators.filter(
      (c) => c.permissions?.maintain || c.permissions?.admin
    );

    const json = privileged.map((c) => ({
      login: c.login,
      role: c.permissions?.admin ? "admin" : "maintainer",
      permissions: c.permissions,
    }));

    const txt = privileged.map((c) => `@${c.login}`).join("\n");

    return { json, txt, error: null };
  } catch (err) {
    const msg = `ERROR: Cannot access collaborators for ${repo} — ${err.message}`;
    return { json: null, txt: null, error: msg };
  }
}

async function processRepo(octokit, owner, repo, outputDir) {
  const [{ content: codeownersContent, location }, { json, txt, error }] = await Promise.all([
    getCodeowners(octokit, owner, repo),
    getMaintainers(octokit, owner, repo),
  ]);

  if (location) {
    core.info(`[${repo}] Found CODEOWNERS at ${location}`);
  } else {
    core.info(`[${repo}] No CODEOWNERS file found in any standard location`);
  }
  fs.writeFileSync(path.join(outputDir, `${repo}.CODEOWNERS`), codeownersContent);

  if (error) {
    core.warning(`[${repo}] ${error}`);
    fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.json`), error);
    fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.txt`), error);
  } else {
    core.info(`[${repo}] Found ${json.length} maintainer(s)/admin(s)`);
    fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.json`), JSON.stringify(json, null, 2));
    fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.txt`), txt);
  }
}

async function run() {
  const token = core.getInput("token", { required: true });
  const owner = core.getInput("owner") || github.context.repo.owner;
  const outputDir = core.getInput("output_dir") || "audit";

  const octokit = github.getOctokit(token);

  fs.mkdirSync(outputDir, { recursive: true });

  core.info(`Listing repositories for ${owner}...`);

  const repos = await octokit.paginate(octokit.rest.repos.listForOrg, {
    org: owner,
    per_page: 100,
  });

  core.info(`Found ${repos.length} repositories. Processing with concurrency=${CONCURRENCY}...`);

  // Process in batches of CONCURRENCY to avoid hitting API rate limits
  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(({ name: repo }) => processRepo(octokit, owner, repo, outputDir)));
  }

  core.setOutput("output_dir", outputDir);
  core.info(`Done. Audit files written to ${outputDir}/`);
}

run().catch((err) => {
  core.setFailed(err.message);
});
