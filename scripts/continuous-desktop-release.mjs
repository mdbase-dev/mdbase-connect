import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { api, checkoutProductionCommit, gh, git, nextBetaVersion, pages, remoteTagCommit, repository, requireGreenMain, requireRunning, verifyCompatibility } from "./lib/continuous-client-release.mjs";

const channelName = "mdbase-connect-channel-v1.json";
const marker = "Continuous desktop status: stopped";
const day = 24 * 60 * 60 * 1000;

export function desktopChanged(paths, contents) {
  return paths.some(path => /^(?:apps\/(?:desktop|editor)\/|packages\/|runtime\/(?:crates|xtask|tools)\/|runtime\/packages\/sdk\/|runtime\/Cargo\.|runtime\/rust-toolchain|runtime\/\.cargo\/|pnpm-|package\.json|deploy\/docker\/mdbase-rs-revision|config\/desktop-update-minimum\.json)/.test(path)
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

const betaNumber = tag => {
  const match = /^v0\.1\.0-beta\.([1-9][0-9]*)$/.exec(tag);
  if (!match) throw new Error("Invalid desktop release tag.");
  return BigInt(match[1]);
};

export function desktopPlan({ latest, reservations, changed, acknowledged = "", now = Date.now() }) {
  const reconciled = acknowledged ? betaNumber(acknowledged) : 0n;
  if (reservations.some(item => !item.published && betaNumber(item.tag) > reconciled)) throw new Error("An automatic desktop attempt is unfinished; inspect its workflow and tag before recovery.");
  if (latest?.body?.includes(marker)) throw new Error("Desktop line is latched stopped; release-owner review required.");
  if (latest) {
    const age = now - Date.parse(latest.published_at);
    if (!Number.isFinite(age) || age < 0) throw new Error("Invalid desktop publication time.");
    if (age < day) return { operation: "wait", reason: "daily limit" };
  }
  return changed ? { operation: "release" } : { operation: "wait", reason: "desktop tree unchanged" };
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

function releaseList() {
  return pages("releases?per_page=100").filter(release => !release.draft
    && release.assets.some(asset => asset.name === channelName))
    .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at));
}

function writeApi(path, body) {
  return JSON.parse(execFileSync("gh", ["api", "--method", "POST", `repos/${repository}/${path}`, "--input", "-"],
    { input: JSON.stringify(body), encoding: "utf8" }));
}

export async function coordinate(env = process.env) {
  requireRunning(env.DESKTOP_RELEASE_STOPPED);
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
    const plan = desktopPlan({ latest, reservations: records, changed, acknowledged: env.DESKTOP_RELEASE_ACKNOWLEDGED_TAG });
    console.log(JSON.stringify(plan));
    if (plan.operation === "wait") return;
    await verifyCompatibility(env);
    assert.equal(api("actions/workflows/desktop-release.yml").state, "active", "Desktop publication workflow has been stopped.");
    const versions = git("tag", "--list", "v*").split("\n").filter(tag => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)).map(tag => tag.slice(1));
    versions.push(JSON.parse(readFileSync("package.json", "utf8")).version,
      ...all.map(release => release.tag_name.slice(1)));
    assert.match(env.GITHUB_RUN_ID ?? "", /^[1-9][0-9]*$/);
    const tag = `v${nextBetaVersion(versions)}`;
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
  assert.match(tag, /^v0\.1\.0-beta\.[1-9][0-9]*$/);
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

export async function compatible(env = process.env) {
  requireRunning(env.DESKTOP_RELEASE_STOPPED);
  assert.equal(api("actions/workflows/desktop-release.yml").state, "active", "Desktop publication workflow has been stopped.");
  return verifyCompatibility(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const commands = { coordinate, prepare: prepareDesktop, compatible };
  const command = commands[process.argv[2]];
  if (!command) throw new Error("Expected coordinate, prepare or compatible.");
  await command();
}
