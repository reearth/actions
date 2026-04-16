const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");
const path = require("path");

const CODEOWNERS_LOCATIONS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

async function getCodeowners(octokit, owner, repo) {
  for (const location of CODEOWNERS_LOCATIONS) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: location });
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { content, location };
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
    return {
      json: null,
      txt: null,
      error: msg,
    };
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

  core.info(`Found ${repos.length} repositories.`);

  for (const { name: repo } of repos) {
    core.startGroup(repo);

    // CODEOWNERS
    const { content: codeownersContent, location } = await getCodeowners(octokit, owner, repo);
    if (location) {
      core.info(`Found CODEOWNERS at ${location}`);
    } else {
      core.info(`No CODEOWNERS file found in any standard location`);
    }
    fs.writeFileSync(path.join(outputDir, `${repo}.CODEOWNERS`), codeownersContent);

    // Maintainers
    const { json, txt, error } = await getMaintainers(octokit, owner, repo);
    if (error) {
      core.warning(error);
      fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.json`), error);
      fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.txt`), error);
    } else {
      core.info(`Found ${json.length} maintainer(s)/admin(s)`);
      fs.writeFileSync(
        path.join(outputDir, `${repo}.MAINTAINERS.json`),
        JSON.stringify(json, null, 2)
      );
      fs.writeFileSync(path.join(outputDir, `${repo}.MAINTAINERS.txt`), txt);
    }

    core.endGroup();
  }

  core.setOutput("output_dir", outputDir);
  core.info(`Done. Audit files written to ${outputDir}/`);
}

run().catch((err) => {
  core.setFailed(err.message);
});
