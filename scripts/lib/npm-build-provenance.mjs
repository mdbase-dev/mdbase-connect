import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { repository } from "./continuous-client-release.mjs";

// Keep npm's certificate-bound workflow fields intact. The explicit build
// source is a signed external parameter, independent of the workflow revision.
export function buildPredicate(env) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  for (const sha of [env.GITHUB_SHA, env.PUBLICATION_RUN_COMMIT]) assert.match(sha ?? "", /^[a-f0-9]{40}$/);
  const workflow = env.GITHUB_WORKFLOW === "Publish npm packages" ? "publish-npm.yml" : "publish-sdk-npm.yml";
  assert(["Publish npm packages", "Publish source-built SDK"].includes(env.GITHUB_WORKFLOW));
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/${workflow}@refs/heads/main`);
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted");
  const url = `https://github.com/${repository}`;
  return {
    buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: {
        workflow: { ref: env.GITHUB_REF, repository: url, path: `.github/workflows/${workflow}` },
        source: { repository: url, commit: env.GITHUB_SHA },
      },
      internalParameters: { github: { event_name: env.GITHUB_EVENT_NAME,
        repository_id: env.GITHUB_REPOSITORY_ID, repository_owner_id: env.GITHUB_REPOSITORY_OWNER_ID } },
      resolvedDependencies: [{ uri: `git+${url}@${env.GITHUB_REF}`, digest: { gitCommit: env.PUBLICATION_RUN_COMMIT } }],
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: { invocationId: `${url}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}` },
    },
  };
}

export function npmBuildStatement(archive, name, version, env) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `pkg:npm/${name.split("/").map(encodeURIComponent).join("/")}@${version}`,
      digest: { sha512: createHash("sha512").update(readFileSync(archive)).digest("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: buildPredicate(env),
  };
}

async function signProvenance(payload, type) {
  // Use the same Sigstore implementation npm uses, without workspace installs
  // or a second signing identity in the protected publishing job.
  const npm = join(execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(), "npm/package.json");
  const { attest } = createRequire(npm)("sigstore");
  return attest(payload, type);
}

export async function publishArchive(archive, name, version, env = process.env, {
  sign = signProvenance, runNpm = execFileSync
} = {}) {
  const statement = npmBuildStatement(archive, name, version, env);
  const bundle = await sign(Buffer.from(JSON.stringify(statement)), "application/vnd.in-toto+json");
  const proof = `${archive}.sigstore.json`;
  writeFileSync(proof, JSON.stringify(bundle));
  runNpm("npm", ["publish", archive, "--ignore-scripts", "--access", "public", "--registry", "https://registry.npmjs.org/",
    "--tag", "latest", "--provenance-file", proof], { stdio: "inherit", env: { ...env, GITHUB_SHA: env.PUBLICATION_RUN_COMMIT } });
}
