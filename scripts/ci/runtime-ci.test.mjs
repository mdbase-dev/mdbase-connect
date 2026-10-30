import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
const server = workflow("server-ci");
const native = workflow("runtime-native-tests");

test("runtime PRs and the merge queue share exhaustive retry-free native test shards", () => {
  assert.match(workflow("runtime-ci"), /native:\n    uses: \.\/\.github\/workflows\/runtime-native-tests.yml/);
  assert.match(workflow("runtime-ci"), /paths:.*runtime-native-tests.yml/);
  assert.match(server, /runtime-native:\n    if: github.event_name == 'merge_group'\n    uses: \.\/\.github\/workflows\/runtime-native-tests.yml/);
  assert.match(native, /packages: --workspace --exclude mdbn-daemon --exclude mdbn-replica/);
  assert.match(native, /packages: -p mdbn-replica/);
  assert.match(native, /packages: -p mdbn-daemon/);
  assert.match(native, /run: cargo test --locked \$\{\{ matrix.packages \}\}/);
  assert.doesNotMatch(native, /--no-run|cargo-test.mjs|--lib/);
});

test("required Qualification rejects failed, cancelled or skipped merge-queue native tests", () => {
  const job = server.split("\n  qualification:\n")[1];
  assert.match(job, /      - runtime-native\n/);
  assert.match(job, /RUNTIME_NATIVE: \$\{\{ needs.runtime-native.result \}\}/);
  const body = job.split("        run: |\n")[1].split("\n      - ")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const env = Object.fromEntries([
    "WINDOWS", "WINDOWS_DAEMON", "RUNTIME", "NODE", "CONTAINER", "SERVER_UPGRADE",
    "SERVER_RETAINED_V2", "PROVIDER_UPGRADE", "RETAINED_V2", "PROVIDER_RUST",
    "PROVIDER_SYSTEM", "LOG_POSTGRES", "LOG_DO"
  ].map((name) => [name, "success"]));
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const command = spawnSync("bash", ["-e", "-c", body], {
      env: { ...process.env, ...env, RUN_FULL: "true", GITHUB_EVENT_NAME: "merge_group", RUNTIME_NATIVE: result }
    });
    assert.equal(command.status, result === "success" ? 0 : 1, result);
  }
  const pullRequest = spawnSync("bash", ["-e", "-c", body], {
    env: { ...process.env, ...env, RUN_FULL: "true", GITHUB_EVENT_NAME: "pull_request", RUNTIME_NATIVE: "skipped" }
  });
  assert.equal(pullRequest.status, 0);
});
