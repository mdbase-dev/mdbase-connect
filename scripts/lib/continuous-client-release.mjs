import { execFileSync } from "node:child_process";
import { readProductionRelease } from "../verify-client-publication.mjs";

export const repository = "mdbase-dev/mdbase-connect";
export const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
export const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();
export const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));
export const pages = (path) => JSON.parse(gh("api", "--paginate", "--slurp", `repos/${repository}/${path}`)).flat();

export function nextBetaVersion(versions) {
  let maximum = 0n;
  for (const version of versions) {
    if (/^0\.0\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) continue;
    const match = /^0\.1\.0-beta\.([1-9][0-9]*)$/.exec(version);
    if (!match) throw new Error(`Cannot advance the beta line beyond published version ${version}; release-owner review required.`);
    const number = BigInt(match[1]);
    if (number > maximum) maximum = number;
  }
  return `0.1.0-beta.${maximum + 1n}`;
}

export function requireRunning(value) {
  if (value !== undefined && value !== "" && value !== "false") {
    throw new Error("Client release line is stopped (or its stop switch is malformed).");
  }
}

export function contractSensitive(path) {
  if (/(?:^|\/)(?:test|tests|__tests__|examples)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return false;
  if (/^(?:docs|changelog\.d|architecture\.d)\//.test(path) || /(?:^|\/)(?:README|CHANGELOG)\.md$/.test(path)) return false;
  if (/^(?:apps\/(?:desktop|editor|portal)|packages\/(?:app-ui|connect-ui|ui))\//.test(path)
      && /\.(?:css|scss|png|jpe?g|webp|gif|ico|icns|svg|woff2?|ttf)$/.test(path)) return false;
  if (/^(?:apps\/(?:desktop|editor|portal)\/src\/i18n|packages\/i18n\/src\/locales)\//.test(path)
      && /\.(?:po|json)$/.test(path)) return false;
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

export async function verifyCompatibility(env = process.env) {
  if (env.GITHUB_REPOSITORY !== repository) throw new Error("Unexpected publication repository.");
  const candidate = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(candidate ?? "") || git("rev-parse", "HEAD") !== candidate) {
    throw new Error("Client source does not match the exact workflow commit.");
  }
  git("fetch", "--no-tags", "origin", "main:refs/remotes/origin/main");
  git("merge-base", "--is-ancestor", candidate, "origin/main");
  const production = await readProductionRelease();
  const provider = remoteTagCommit(`v${production.version}`);
  git("fetch", "--no-tags", "origin", production.sha);
  git("fetch", "--no-tags", "origin", provider);
  const evidence = proveCompatibility(candidate, production.sha);
  const providerEvidence = proveCompatibility(candidate, provider);
  evidence.provider = provider;
  evidence.providerReason = providerEvidence.reason;
  console.log(JSON.stringify(evidence));
  return evidence;
}

export function requireGreenMain(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Expected a full main commit.");
  execFileSync("scripts/ci/verify-qualified-commit", [commit], { stdio: "inherit" });
}

export function remoteTagCommit(tag) {
  const ref = api(`git/ref/tags/${tag}`);
  if (ref.object?.type !== "tag") throw new Error("Invalid release tag object.");
  const object = api(`git/tags/${ref.object.sha}`);
  if (object.object?.type !== "commit") throw new Error("Release tag must identify a commit directly.");
  return object.object.sha;
}
