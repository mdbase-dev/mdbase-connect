import { execFileSync } from "node:child_process";
import { readProductionRelease } from "../verify-client-publication.mjs";
import { parseFragment } from "./changelog.mjs";

export const repository = "mdbase-dev/mdbase-connect";
// Caught command failures must not echo raw stderr before a bounded diagnostic.
export const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
// The paginated release list has outgrown Node's default 1 MiB output buffer.
export const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: "pipe", maxBuffer: 256 * 1024 * 1024 }).trim();
export const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));
export const pages = (path) => JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/${path}`)).flat();

// Releases are plain semver. Before 0.1.0 the line published 0.1.0-beta.N, and
// 0.0.x bootstrap versions exist on npm; both stay readable and order below
// 0.1.0. Any other form refuses for release-owner review.
export const releaseVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const releaseTag = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const bootstrap = /^0\.0\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const legacyBeta = /^0\.1\.0-beta\.([1-9][0-9]*)$/;

function versionKey(version) {
  const release = releaseVersion.exec(version);
  if (release) return [BigInt(release[1]), BigInt(release[2]), BigInt(release[3]), 1n, 0n];
  const beta = legacyBeta.exec(version);
  if (beta) return [0n, 1n, 0n, 0n, BigInt(beta[1])];
  if (bootstrap.test(version)) return [0n, 0n, 0n, 0n, 0n];
  throw new Error(`Cannot order published version ${version}; release-owner review required.`);
}

export function compareVersions(left, right) {
  const [a, b] = [versionKey(left), versionKey(right)];
  const index = a.findIndex((value, position) => value !== b[position]);
  return index < 0 ? 0 : a[index] < b[index] ? -1 : 1;
}

// The highest plain release among versions, or null while only betas exist.
export function latestRelease(versions) {
  return versions.filter(version => versionKey(version)[3] === 1n)
    .reduce((highest, version) => highest && compareVersions(highest, version) >= 0 ? highest : version, null);
}

// Pre-1.0, a breaking change bumps the minor version and anything else the patch.
export function nextVersion(versions, breaking) {
  const latest = latestRelease(versions);
  if (!latest) return "0.1.0";
  const [major, minor, patch] = latest.split(".").map(BigInt);
  if (major !== 0n) throw new Error(`Versioning beyond ${latest} needs a release-owner decision.`);
  return breaking ? `0.${minor + 1n}.0` : `0.${minor}.${patch + 1n}`;
}

// Whether a changelog.d fragment present at `commit` but not at `base` is breaking.
export function breakingSince(base, commit, runGit = git) {
  return runGit("diff", "--no-renames", "--name-only", "--diff-filter=A", "-z", base, commit, "--", "changelog.d/")
    .split("\0").filter(Boolean)
    .some(path => parseFragment(path.slice("changelog.d/".length), runGit("show", `${commit}:${path}`) + "\n").section === "Breaking");
}

// The next version above every version given, bumped by the fragments added
// since the release that holds the highest version. Every line shares the v*
// tag namespace, so that release's tag exists locally.
export function allocateVersion(versions, commit, runGit = git) {
  const latest = latestRelease(versions);
  if (!latest) return nextVersion(versions, false);
  const base = runGit("rev-parse", "--verify", `refs/tags/v${latest}^{commit}`);
  return nextVersion(versions, breakingSince(base, commit, runGit));
}

export function requireRunning(value) {
  if (value !== undefined && value !== "" && value !== "false") {
    throw new Error("Client release line is stopped (or its stop switch is malformed).");
  }
}

export function contractSensitive(path) {
  if (/(?:^|\/)(?:test|tests|__tests__|examples)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/^(?:docs|changelog\.d)\//.test(path) || /(?:^|\/)(?:README|CHANGELOG|DESIGN)\.md$/.test(path)) return false;
  if (/^(?:apps\/(?:desktop|editor|portal)|packages\/(?:app-ui|connect-ui|ui))\//.test(path)
      && /\.(?:css|scss|png|jpe?g|webp|gif|ico|icns|svg|woff2?|ttf)$/.test(path)) return false;
  if (/^(?:apps\/(?:desktop|editor|portal)\/src\/i18n|packages\/i18n\/src\/locales)\//.test(path)
      && /\.(?:po|json)$/.test(path)) return false;
  if (/^(?:apps\/(?:desktop|portal)\/src|packages\/app-ui\/src|packages\/ui)\/locales\/[^/]+\/messages\.po$/.test(path)) return false;
  if (/^\.github\/workflows\/(?:desktop-release|publish-sdk-npm|publish-npm)\.yml$/.test(path)) return false;
  if (/^scripts\/(?:lib\/)?(?:continuous-(?:client|desktop|sdk)-release|generate-update-manifest|write-update-input|package-headless-cli|public-packages)(?:[./-]|$)/.test(path)) return false;
  if (path === "config/desktop-update-minimum.json") return false;
  return true;
}

export function proveCompatibility(candidate, production, runGit = git) {
  for (const commit of [candidate, production]) {
    if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Compatibility requires full commit identities.");
    runGit("cat-file", "-e", `${commit}^{commit}`);
  }
  try {
    runGit("merge-base", "--is-ancestor", candidate, production);
    return { candidate, production, reason: "production-contains-candidate" };
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  runGit("merge-base", candidate, production);
  const paths = runGit("diff", "--no-renames", "--name-only", "-z", production, candidate).split("\0").filter(Boolean);
  const contract = paths.filter(contractSensitive);
  if (contract.length) throw new Error(`Production does not contain this client's server-facing contract: ${contract.join(", ")}`);
  return { candidate, production, reason: "unchanged-contract-axis" };
}

export async function verifyCompatibility(env = process.env, { settleMs = 0 } = {}) {
  if (env.GITHUB_REPOSITORY !== repository) throw new Error("Unexpected publication repository.");
  const candidate = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(candidate ?? "") || git("rev-parse", "HEAD") !== candidate) {
    throw new Error("Client source does not match the exact workflow commit.");
  }
  git("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
  git("merge-base", "--is-ancestor", candidate, "origin/main");
  const production = await readProductionRelease(globalThis.fetch, { settleMs });
  const provider = production.providerSha;
  git("fetch", "--no-tags", "origin", production.sha);
  git("fetch", "--no-tags", "origin", provider);
  const evidence = proveCompatibility(candidate, production.sha);
  const providerEvidence = proveCompatibility(candidate, provider);
  evidence.provider = provider;
  evidence.providerReason = providerEvidence.reason;
  console.log(JSON.stringify(evidence));
  return evidence;
}

// Select from live production ancestry, not the workflow's (possibly superseded)
// main SHA. Keep selection separate from the fresh compatibility publication gate.
export async function checkoutProductionCommit(env = process.env, {
  readProduction = readProductionRelease, runGit = git, readApi = api, qualify = requireGreenMain
} = {}) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Client selection requires this repository's main workflow.");
  }
  runGit("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
  const production = await readProduction();
  for (const commit of [production.sha, production.providerSha]) {
    if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Production requires full commit identities.");
    runGit("fetch", "--no-tags", "origin", commit);
  }
  const common = runGit("merge-base", "--octopus", "origin/main", production.sha, production.providerSha);
  for (const commit of runGit("rev-list", "--first-parent", common).split("\n").filter(Boolean)) {
    const runs = readApi(`actions/workflows/server-ci.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`).workflow_runs;
    if (!runs.some(run => run.head_sha === commit && run.head_branch === "main" && run.event === "push"
        && run.status === "completed" && run.conclusion === "success" && run.path === ".github/workflows/server-ci.yml")) continue;
    runGit("checkout", "--detach", commit);
    // A green badge alone is not full qualification. Invalid/unavailable exact
    // artifacts refuse rather than silently falling back to an older release.
    qualify(commit);
    console.log(JSON.stringify({ candidate: commit, production: production.sha, provider: production.providerSha }));
    return commit;
  }
  throw new Error("No green main commit is contained by both production services.");
}

export function requireGreenMain(commit, env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Expected a full main commit.");
  // Windows cannot spawn an extensionless script directly.
  execFileSync("bash", ["scripts/ci/verify-qualified-commit", commit], { stdio: "inherit", env });
}

export function remoteTagCommit(tag) {
  const ref = api(`git/ref/tags/${tag}`);
  if (ref.object?.type !== "tag") throw new Error("Invalid release tag object.");
  const object = api(`git/tags/${ref.object.sha}`);
  if (object.object?.type !== "commit") throw new Error("Release tag must identify a commit directly.");
  return object.object.sha;
}
