#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readProductionRelease, verifyRemotePublicationTag } from "./verify-client-publication.mjs";

// Editor-only publication reuses the released backend-facing build inputs.
// Changes here require the coordinated tagged path, not an operator waiver.
export const backendFacingInputs = [
  "packages/client", "packages/protocol", "packages/management",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
  "tsconfig.json", "tsconfig.base.json", ".env*",
  "apps/editor/package.json", "apps/editor/vite.config.ts",
  "apps/editor/tsconfig*.json", "apps/editor/.env*",
  "apps/editor/scripts", "apps/editor/public/.well-known"
];

export function verifyEditorSource({ event, ref, repository, sha, head, verifiedCommit }) {
  if (event !== "workflow_dispatch" || ref !== "refs/heads/main" ||
      repository !== "mdbase-dev/mdbase-connect" ||
      !/^[0-9a-f]{40}$/.test(sha ?? "") || head !== sha || verifiedCommit) {
    throw new Error("Editor-only publication requires an exact main-branch dispatch with no coordinated-release override.");
  }
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd();

export function verifyEditorBuildInputs(backendSha, sourceSha, runGit = git) {
  if (![backendSha, sourceSha].every((sha) => /^[0-9a-f]{40}$/.test(sha ?? ""))) {
    throw new Error("Exact backend and Editor source commits are required.");
  }
  // The source must retain the deployed release, not be an old/divergent UI.
  runGit(["merge-base", "--is-ancestor", backendSha, sourceSha]);
  const changed = runGit([
    "diff", "--no-renames", "--name-only", "-z", backendSha, sourceSha, "--", ...backendFacingInputs
  ]).split("\0").filter(Boolean);
  if (changed.length) {
    throw new Error(`Editor backend-facing inputs changed; use the coordinated tagged release path: ${changed.join(", ")}`);
  }
}

export async function main(env = process.env) {
  const sha = env.GITHUB_SHA;
  verifyEditorSource({
    event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY, sha, head: git(["rev-parse", "HEAD"]),
    verifiedCommit: env.PRODUCTION_VERIFIED_COMMIT
  });
  // checkout fetch-depth: 0 supplies main and the annotated backend release.
  // A later main commit is fine, but an unmerged source is never eligible.
  git(["merge-base", "--is-ancestor", sha, "origin/main"]);
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Editor publication requires an unchanged tracked source checkout.");
  }
  const release = await readProductionRelease();
  const api = (path) => JSON.parse(execFileSync("gh", [
    "api", `repos/mdbase-dev/mdbase-connect/${path}`
  ], { encoding: "utf8" }));
  verifyRemotePublicationTag({ ...release, ref: `refs/tags/v${release.version}` }, api);
  verifyEditorBuildInputs(release.sha, sha);
  console.log(`Editor ${sha} may publish against production v${release.version} (${release.sha}); backend-facing build inputs are unchanged.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
