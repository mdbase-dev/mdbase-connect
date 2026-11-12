import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("./provider-migration-rollback-gate", import.meta.url));
const server = readFileSync(new URL("../../.github/workflows/server-ci.yml", import.meta.url), "utf8");
const migrations = "crates/connect-hosted-provider/migrations";
const marker = "-- mdbase: rollback-compatible";
const tolerant = [
  'pub const MIGRATION_ROLLBACK_TOLERANCE: &str = "marked-v1";',
  'pub const PROJECTION_INDEXER_MIGRATION_TOLERANCE: &str = "marked-v1";'
].join("\n");

// A throwaway repository whose base commit is a tolerant previous release.
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "migration-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (subject) => {
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  put(`${migrations}/0001_init.sql`, "CREATE TABLE a (id int);\n");
  put("crates/connect-hosted-provider/src/provider.rs", `${tolerant}\n`);
  put("crates/connect-hosted-provider/tests/support/test_postgres.rs", "// MDBASE_TEST_NEWER_HOSTED_MIGRATIONS\n");
  put("scripts/ci/hosted-provider-postgres-tests", "#!/bin/sh\n");
  const base = commit("Base (#1)");
  return { root, git, put, commit, base, remove: (path) => rmSync(join(root, path)) };
}

// Run the gate as a CI step would, with a stub gh that answers pull request
// label reads from `labels` (number -> names) and fails for anything else.
function run(t, repo, head, { event, payload = {}, labels = {} } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "migration-gate-run-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  writeFileSync(join(scratch, "labels.json"), JSON.stringify(labels));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${scratch}/gh.log"
[[ $1 == api && $2 =~ ^repos/mdbase-dev/mdbase-connect/pulls/([0-9]+)$ && $3 == --jq ]] || exit 1
jq -er --arg n "\${BASH_REMATCH[1]}" '.[$n] // error("missing") | .[]' "${scratch}/labels.json"
`);
  chmodSync(join(bin, "gh"), 0o755);
  const eventPath = join(scratch, "event.json");
  writeFileSync(eventPath, JSON.stringify(payload));
  const output = join(scratch, "output");
  writeFileSync(output, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: join(scratch, "summary"), GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect" };
  delete env.GITHUB_EVENT_NAME;
  delete env.GITHUB_EVENT_PATH;
  if (event) Object.assign(env, { GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath });
  const result = spawnSync("bash", [gate, repo.base, head], { cwd: repo.root, env, encoding: "utf8" });
  let ghLog = "";
  try { ghLog = readFileSync(join(scratch, "gh.log"), "utf8"); } catch { /* gh never ran */ }
  return { status: result.status, text: result.stdout + result.stderr, output: readFileSync(output, "utf8"), ghLog };
}

const pullRequest = (...names) => ({ pull_request: { labels: names.map((name) => ({ name })) } });

test("an unmarked new migration fails without the forward-only-approved label", (t) => {
  const repo = repository(t);
  repo.put(`${migrations}/0002_drop.sql`, "ALTER TABLE a DROP COLUMN id;\n");
  const head = repo.commit("Drop a column (#2)");
  const refused = run(t, repo, head, { event: "pull_request", payload: pullRequest("ci:full") });
  assert.equal(refused.status, 1, refused.text);
  assert.match(refused.text, /::error::FORWARD-ONLY: this pull request needs the forward-only-approved label/);
  assert.match(refused.text, /release supervisor/);
  assert.match(refused.text, /Callum's yes/);
  assert.match(refused.output, /run_proof=false/);
  const approved = run(t, repo, head, { event: "pull_request", payload: pullRequest("ci:full", "forward-only-approved") });
  assert.equal(approved.status, 0, approved.text);
  assert.match(approved.text, /::notice::FORWARD-ONLY change approved/);
  assert.match(approved.output, /run_proof=false/);
  assert.equal(approved.ghLog, "", "a pull_request run reads its labels from the event");
});

test("editing or removing an existing migration fails without the label", (t) => {
  for (const change of ["edit", "remove"]) {
    const repo = repository(t);
    if (change === "edit") repo.put(`${migrations}/0001_init.sql`, "CREATE TABLE a (id bigint);\n");
    else repo.remove(`${migrations}/0001_init.sql`);
    const head = repo.commit(`${change} (#2)`);
    const refused = run(t, repo, head, { event: "pull_request", payload: pullRequest() });
    assert.equal(refused.status, 1, `${change}: ${refused.text}`);
    assert.match(refused.text, /edits or removes the existing migration/);
    assert.match(refused.text, /needs the forward-only-approved label/);
    const approved = run(t, repo, head, { event: "pull_request", payload: pullRequest("forward-only-approved") });
    assert.equal(approved.status, 0, `${change}: ${approved.text}`);
  }
});

test("marked migrations on a tolerant previous release need no label and run the proof", (t) => {
  const repo = repository(t);
  repo.put(`${migrations}/0002_add.sql`, `${marker}\nALTER TABLE a ADD COLUMN b int;\n`);
  const head = repo.commit("Add a column (#2)");
  const result = run(t, repo, head, { event: "pull_request", payload: pullRequest() });
  assert.equal(result.status, 0, result.text);
  assert.match(result.output, /run_proof=true/);
  assert.doesNotMatch(result.text, /forward-only-approved/);
});

test("marked migrations on an intolerant previous release are forward-only and need the label", (t) => {
  const repo = repository(t);
  repo.put("crates/connect-hosted-provider/src/provider.rs", "// no tolerance\n");
  const base = repo.commit("Intolerant base (#1)");
  repo.put(`${migrations}/0002_add.sql`, `${marker}\nALTER TABLE a ADD COLUMN b int;\n`);
  const head = repo.commit("Add a column (#2)");
  const intolerant = { ...repo, base };
  assert.equal(run(t, intolerant, head, { event: "pull_request", payload: pullRequest() }).status, 1);
  assert.equal(run(t, intolerant, head, { event: "pull_request", payload: pullRequest("forward-only-approved") }).status, 0);
});

test("no new migrations need no label", (t) => {
  const repo = repository(t);
  repo.put("README.md", "docs\n");
  const head = repo.commit("Docs (#2)");
  const result = run(t, repo, head, { event: "pull_request", payload: pullRequest() });
  assert.equal(result.status, 0, result.text);
  assert.match(result.output, /run_proof=false/);
});

test("the merge queue reads the labels of the pull requests that made the forward-only change", (t) => {
  const repo = repository(t);
  repo.put("README.md", "docs\n");
  repo.commit("Unrelated docs (#7)");
  repo.put(`${migrations}/0002_drop.sql`, "ALTER TABLE a DROP COLUMN id;\n");
  const head = repo.commit("Drop a column (#8)");
  const payload = { merge_group: { head_ref: "refs/heads/gh-readonly-queue/main/pr-8-0123", base_sha: repo.base } };
  const approved = run(t, repo, head, { event: "merge_group", payload, labels: { 8: ["forward-only-approved"] } });
  assert.equal(approved.status, 0, approved.text);
  assert.match(approved.ghLog, /pulls\/8 /);
  assert.doesNotMatch(approved.ghLog, /pulls\/7 /, "only the responsible pull request is read");
  const unlabeled = run(t, repo, head, { event: "merge_group", payload, labels: { 8: ["ci:full"] } });
  assert.equal(unlabeled.status, 1, unlabeled.text);
  assert.match(unlabeled.text, /#8 does not carry the forward-only-approved label/);
  const unreadable = run(t, repo, head, { event: "merge_group", payload, labels: {} });
  assert.equal(unreadable.status, 1, unreadable.text);
  assert.match(unreadable.text, /Could not read the labels of pull request #8/);
});

test("the merge queue requires every responsible pull request to be approved", (t) => {
  const repo = repository(t);
  repo.put(`${migrations}/0002_drop.sql`, "ALTER TABLE a DROP COLUMN id;\n");
  repo.commit("First breaking change (#11)");
  repo.put(`${migrations}/0003_drop.sql`, "DROP TABLE a;\n");
  const head = repo.commit("Second breaking change (#12)");
  const payload = { merge_group: { head_ref: "refs/heads/gh-readonly-queue/main/pr-12-0123", base_sha: repo.base } };
  assert.equal(run(t, repo, head, { event: "merge_group", payload,
    labels: { 11: ["forward-only-approved"], 12: ["forward-only-approved"] } }).status, 0);
  assert.equal(run(t, repo, head, { event: "merge_group", payload,
    labels: { 11: [], 12: ["forward-only-approved"] } }).status, 1);
});

test("the merge queue names the head commit's pull request from its head ref and fails closed otherwise", (t) => {
  const repo = repository(t);
  repo.put(`${migrations}/0002_drop.sql`, "ALTER TABLE a DROP COLUMN id;\n");
  const head = repo.commit("Drop a column without a number");
  const labels = { 9: ["forward-only-approved"] };
  const named = { merge_group: { head_ref: "refs/heads/gh-readonly-queue/main/pr-9-0123", base_sha: repo.base } };
  assert.equal(run(t, repo, head, { event: "merge_group", payload: named, labels }).status, 0);
  const unnamed = run(t, repo, head, { event: "merge_group", payload: { merge_group: { base_sha: repo.base } }, labels });
  assert.equal(unnamed.status, 1, unnamed.text);
  assert.match(unnamed.text, /Cannot tell which pull request made merge-queue commit/);
});

test("a run that cannot see labels fails a forward-only change closed", (t) => {
  const repo = repository(t);
  repo.put(`${migrations}/0002_drop.sql`, "ALTER TABLE a DROP COLUMN id;\n");
  const head = repo.commit("Drop a column (#2)");
  assert.equal(run(t, repo, head).status, 1);
  assert.equal(run(t, repo, head, { event: "push", payload: pullRequest("forward-only-approved") }).status, 1);
});

test("label changes rerun the gate, which can read pull request labels in the merge queue", () => {
  assert.match(server, /pull_request:\n    types: \[[^\]]*\blabeled\b[^\]]*\]/);
  assert.match(server, /pull_request:\n    types: \[[^\]]*\bunlabeled\b[^\]]*\]/);
  assert.match(server, /\n  merge_group:\n/);
  const job = server.split("\n  provider-migration-rollback:\n")[1].split("\n  qualification:\n")[0];
  assert.match(job, /    if: github.event_name != 'push'\n/);
  assert.match(job, /    permissions:\n      contents: read\n      pull-requests: read\n/);
  assert.match(job, /GH_TOKEN: \$\{\{ github.token \}\}\n        run: scripts\/ci\/provider-migration-rollback-gate "\$BASE" "\$GITHUB_SHA"/);
  assert.match(job, /BASE: \$\{\{ github.event.pull_request.base.sha \|\| github.event.merge_group.base_sha \}\}/);
});
