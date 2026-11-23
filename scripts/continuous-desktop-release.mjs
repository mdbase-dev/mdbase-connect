import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allocateVersion, api, checkoutProductionCommit, compareVersions, gh, git, pages, productionOnlyCompatibility, releaseTag, remoteTagCommit, repository, requireGreenMain, requireRunning, verifyCompatibility } from "./lib/continuous-client-release.mjs";
import { readRollout } from "./desktop-rollout.mjs";
import { rolloutService, stageOf, variableSet, wideningLimit, wideningPlan } from "./lib/desktop-rollout.mjs";

const channelName = "mdbase-connect-channel-v1.json";
const marker = "Continuous desktop status: stopped";
const hour = 60 * 60 * 1000;
// With staged rollout, each release reaches people in stages and installations
// without early access take at most one optional update a day themselves, so a
// desktop change releases as soon as it merges, like every other client. The
// 24-hour gap remains only until the rollout service is enabled.
export const releaseGap = (staged) => (staged ? 0 : 24 * hour);

export function desktopChanged(paths, contents) {
  return paths.some(path => /^(?:apps\/(?:desktop|editor)\/|packages\/|runtime\/(?:crates|xtask|tools)\/|runtime\/packages\/sdk\/|runtime\/Cargo\.|runtime\/rust-toolchain|runtime\/\.cargo\/|pnpm-|package\.json|config\/desktop-update-minimum\.json)/.test(path)
    && !/(?:^|\/)(?:test|tests|__tests__)\//.test(path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    && !/\.(?:md|mdx)$/.test(path) && (() => {
      if (!contents || !/(?:^|\/)package(?:-lock)?\.json$/.test(path)) return true;
      const { before, after } = contents(path);
      if (before === undefined || after === undefined) return true;
      const normalize = text => {
        const value = JSON.parse(text);
        delete value.version;
        if (value.packages?.[""]) delete value.packages[""].version;
        return JSON.stringify(value);
      };
      return normalize(before) !== normalize(after);
    })());
}

// Tags are v<version>; legacy v0.1.0-beta.N reservations still order below releases.
const tagVersion = tag => {
  if (!/^v[0-9]/.test(tag)) throw new Error("Invalid desktop release tag.");
  return tag.slice(1);
};

// The desktop workflow runs the prepare step committed at its tag. Transition
// guard: a commit whose prepare step predates semver tags cannot publish one.
// Remove once production contains semver desktop releases.
export function semverPrepare(commit, runGit = git) {
  return runGit("show", `${commit}:scripts/continuous-desktop-release.mjs`).includes("assert.match(tag, releaseTag);");
}

export function desktopPlan({ latest, reservations, changed, acknowledged = "", semver = true, compatible = true, gap = releaseGap(false), now = Date.now() }) {
  const unreconciled = item => !acknowledged || compareVersions(tagVersion(item.tag), tagVersion(acknowledged)) > 0;
  if (reservations.some(item => !item.published && unreconciled(item))) throw new Error("An automatic desktop attempt is unfinished; inspect its workflow and tag before recovery.");
  if (latest?.body?.includes(marker)) throw new Error("Desktop line is latched stopped; release-owner review required.");
  if (latest) {
    const age = now - Date.parse(latest.published_at);
    if (!Number.isFinite(age) || age < 0) throw new Error("Invalid desktop publication time.");
    if (age < gap) return { operation: "wait", reason: "release gap" };
  }
  if (!changed) return { operation: "wait", reason: "desktop tree unchanged" };
  if (!semver) return { operation: "wait", reason: "selected commit predates semver releases" };
  if (!compatible) return { operation: "wait", reason: "selected commit predates provider-free compatibility" };
  return { operation: "release" };
}

function reservations(releases) {
  return git("for-each-ref", "--format=%(refname:short)%00%(contents:subject)%00%(*objectname)", "refs/tags/v*")
    .split("\n").filter(Boolean).flatMap(line => {
      const [tag, message, commit] = line.split("\0");
      if (!message.startsWith('{"schema":"mdbase-desktop-release/1"')) return [];
      const record = JSON.parse(message);
      assert.equal(record.commit, commit);
      assert.match(record.reserved_at, /^\d{4}-\d\d-\d\dT/);
      return [{ ...record, tag, published: releases.some(release => !release.draft && release.tag_name === tag) }];
    });
}

function readChannel(release, directory) {
  gh("release", "download", release.tag_name, "--repo", repository, "--pattern", channelName,
    "--pattern", `${channelName}.sigstore.json`, "--dir", directory);
  const manifest = join(directory, channelName);
  execFileSync("cosign", ["verify-blob", "--bundle", `${manifest}.sigstore.json`,
    "--certificate-identity", `https://github.com/${repository}/.github/workflows/desktop-release.yml@refs/tags/${release.tag_name}`,
    "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", manifest], { stdio: "inherit" });
  const channel = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(channel.schema_version, 1);
  assert.equal(channel.tag, release.tag_name);
  assert.equal(`v${channel.version}`, release.tag_name);
  return channel;
}

export function releaseList() {
  return pages("releases?per_page=100").filter(release => !release.draft
    && release.assets.some(asset => asset.name === channelName))
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
}

function writeApi(path, body) {
  return JSON.parse(execFileSync("gh", ["api", "--method", "POST", `repos/${repository}/${path}`, "--input", "-"],
    { input: JSON.stringify(body), encoding: "utf8" }));
}

/**
 * Moves each release still rolling out one stage on once it has held its current
 * stage for six hours. Every release keeps its own clock, so a newer release does
 * not stop an older one reaching everyone. Releases older than the newest one at
 * 100% (or without a rollout document, which clients treat as 100%) are already
 * superseded for every installation and are left alone.
 */
async function widenRollouts(service, releases, env) {
  const held = variableSet(env.DESKTOP_ROLLOUT_HELD, "DESKTOP_ROLLOUT_HELD");
  for (const [index, release] of releases.entries()) {
    if (index === wideningLimit) {
      console.warn(`More than ${wideningLimit} desktop releases are still rolling out; older ones are not widened. Installations without early access look back only that far.`);
      break;
    }
    const document = await readRollout(service, release.tag_name);
    if (!document || stageOf(document) === "100") break;
    const plan = wideningPlan({ document, held });
    console.log(JSON.stringify({ rollout: release.tag_name, ...plan }));
    if (plan.operation !== "widen") continue;
    gh("workflow", "run", "desktop-release.yml", "--repo", repository, "--ref", release.tag_name,
      "-f", "operation=rollout", "-f", `stage=${plan.stage}`);
  }
}

export async function coordinate(env = process.env) {
  requireRunning(env.DESKTOP_RELEASE_STOPPED);
  const service = rolloutService(env.DESKTOP_ROLLOUT_SERVICE);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert(["workflow_run", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.GITHUB_REPOSITORY, repository);
  git("fetch", "--tags", "origin", "main:refs/remotes/origin/main");
  const commit = await checkoutProductionCommit(env);
  env = { ...env, GITHUB_SHA: commit };
  const all = releaseList();
  const latest = all[0];
  const records = reservations(all);
  const directory = mkdtempSync(join(tmpdir(), "desktop-plan-"));
  try {
    if (latest) readChannel(latest, directory);
    const base = latest ? remoteTagCommit(latest.tag_name) : null;
    if (base) git("merge-base", "--is-ancestor", base, env.GITHUB_SHA);
    const paths = base ? git("diff", "--no-renames", "--name-only", "-z", base, env.GITHUB_SHA).split("\0") : ["apps/desktop/"];
    const readAt = (commit, path) => {
      try { return git("show", `${commit}:${path}`); }
      catch (error) { if (error.status === 128) return undefined; throw error; }
    };
    const changed = desktopChanged(paths, path => ({ before: base ? readAt(base, path) : undefined, after: readAt(env.GITHUB_SHA, path) }));
    const plan = desktopPlan({ latest, reservations: records, changed, acknowledged: env.DESKTOP_RELEASE_ACKNOWLEDGED_TAG,
      semver: semverPrepare(env.GITHUB_SHA), compatible: productionOnlyCompatibility(env.GITHUB_SHA), gap: releaseGap(service !== null) });
    console.log(JSON.stringify(plan));
    // After the plan, so a latched stop or an unfinished attempt also pauses widening.
    if (service) await widenRollouts(service, all, env);
    if (plan.operation === "wait") return;
    await verifyCompatibility(env);
    assert.equal(api("actions/workflows/desktop-release.yml").state, "active", "Desktop publication workflow has been stopped.");
    const versions = git("tag", "--list", "v*").split("\n").filter(tag => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)).map(tag => tag.slice(1));
    versions.push(...all.map(release => release.tag_name.slice(1)));
    assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
    const tag = `v${allocateVersion(versions, env.GITHUB_SHA)}`;
    const object = writeApi("git/tags", { tag, object: env.GITHUB_SHA, type: "commit",
      message: JSON.stringify({ schema: "mdbase-desktop-release/1", commit: env.GITHUB_SHA,
        reserved_at: new Date().toISOString(), run_id: env.GITHUB_RUN_ID }) });
    writeApi("git/refs", { ref: `refs/tags/${tag}`, sha: object.sha });
    gh("workflow", "run", "desktop-release.yml", "--repo", repository, "--ref", tag, "-f", "operation=release");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function prepareDesktop(env = process.env) {
  requireRunning(env.DESKTOP_RELEASE_STOPPED);
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  const tag = env.GITHUB_REF_NAME;
  assert.match(tag, releaseTag);
  assert.equal(env.GITHUB_REF, `refs/tags/${tag}`);
  assert.equal(remoteTagCommit(tag), env.GITHUB_SHA);
  const reference = api(`git/ref/tags/${tag}`);
  assert.equal(reference.object.type, "tag");
  const record = JSON.parse(api(`git/tags/${reference.object.sha}`).message);
  assert.equal(record.schema, "mdbase-desktop-release/1");
  assert.equal(record.commit, env.GITHUB_SHA);
  requireGreenMain(env.GITHUB_SHA);
  for (const path of ["package.json", "apps/desktop/package.json"]) {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.version = tag.slice(1);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `value=${tag.slice(1)}\n`);
}

// Server CD promotes Connect and MCP in sequence over about 15 minutes. A tag
// run that overlaps it waits for one consistent production identity rather than
// failing the attempt; the coordinator stays single-shot and retries on schedule.
export const promotionSettleMs = 25 * 60_000;

export async function compatible(env = process.env) {
  requireRunning(env.DESKTOP_RELEASE_STOPPED);
  assert.equal(api("actions/workflows/desktop-release.yml").state, "active", "Desktop publication workflow has been stopped.");
  return verifyCompatibility(env, { settleMs: promotionSettleMs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { coordinate, prepare: prepareDesktop, compatible };
  const command = commands[process.argv[2]];
  if (!command) throw new Error("Expected coordinate, prepare or compatible.");
  await command();
}
