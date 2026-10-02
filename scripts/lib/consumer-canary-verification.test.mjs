import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const commit = "a".repeat(40);
const verifier = resolve(import.meta.dirname, "../ci/verify-consumer-canary");

async function fixture(t, change = {}, apiChange = {}) {
  const root = await mkdtemp(join(tmpdir(), "canary-verification-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "package"));
  await writeFile(join(root, "package/package.json"), JSON.stringify({ name: "@mdbase-dev/connect" }));
  const archive = join(root, "connect.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
  for (const [consumer, repository] of Object.entries({ tasknotes: "callumalpass/tasknotes-app", writer: "mdbase-dev/mdbase-writer", reader: "mdbase-dev/mdbase-reader" })) {
    await writeFile(join(root, `${consumer}.json`), JSON.stringify({
      schema_version: 1, candidate_commit: commit, artifact_run_id: "10", run_id: "20", run_attempt: "2",
      event: "workflow_dispatch", consumer, repository, revision: "b".repeat(40),
      tarballs_sha256: { "@mdbase-dev/connect": hash }, ...change,
    }));
  }
  const run = { id: 20, run_number: 3, run_attempt: 2, head_sha: commit,
    event: "workflow_dispatch", status: "completed", conclusion: "success",
    path: ".github/workflows/consumer-canary.yml", ...apiChange };
  await writeFile(join(root, "runs.json"), JSON.stringify({ workflow_runs: [run] }));
  await writeFile(join(root, "run.json"), JSON.stringify(run));
  await writeFile(join(root, "bin/gh"), `#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == api ]]; then
  if [[ $* == *workflows/consumer-canary.yml/runs* ]]; then
    cat "$FIXTURE/runs.json"
  else
    cat "$FIXTURE/run.json"
  fi
else
  [[ $1 == run && $2 == download ]] || exit 91
  while [[ $# -gt 0 ]]; do
    case $1 in --name) name=$2; shift;; --dir) destination=$2; shift;; esac
    shift
  done
  mkdir -p "$destination"
  if [[ $name == qualified-npm-packages ]]; then
    cp "$FIXTURE/connect.tgz" "$destination/"
  else
    cp "$FIXTURE/\${name#consumer-canary-}.json" "$destination/consumer-canary.json"
  fi
fi
`, { mode: 0o755 });
  return () => spawnSync(verifier, [commit, "10"], {
    encoding: "utf8", env: { ...process.env, FIXTURE: root, PATH: `${root}/bin:${process.env.PATH}` },
  });
}

test("verifies all three exact dispatch reports against qualified tarball bytes", async (t) => {
  const run = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified consumer canary run 20 attempt 2/);
});

for (const [label, change] of [
  ["failed workflow", { conclusion: "failure" }],
  ["cancelled workflow", { conclusion: "cancelled" }],
  ["advisory workflow", { event: "pull_request" }],
  ["still-running workflow", { status: "in_progress" }],
  ["foreign workflow", { path: ".github/workflows/other.yml" }],
]) {
  test(`rejects ${label}`, async (t) => {
    const run = await fixture(t, {}, change);
    assert.notEqual(run().status, 0);
  });
}

for (const [label, change] of [

  ["unknown report schema", { schema_version: 2 }],
  ["PR evidence", { event: "pull_request" }],
  ["another SDK commit", { candidate_commit: "c".repeat(40) }],
  ["another artifact-producing run", { artifact_run_id: "11" }],
  ["stale run attempt", { run_attempt: "1" }],
  ["different tarball bytes", { tarballs_sha256: { "@mdbase-dev/connect": "0".repeat(64) } }],
  ["wrong consumer checkout", { repository: "other/repo" }],
]) {
  test(`rejects ${label}`, async (t) => {
    const run = await fixture(t, change);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity or candidate tarballs differ/);
  });
}
