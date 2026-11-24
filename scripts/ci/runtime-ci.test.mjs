import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CI_JOBS } from "../release-workers.mjs";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
const server = workflow("server-ci");
const runtime = workflow("runtime-ci");
const native = workflow("runtime-native-tests");

test("runtime PRs and the merge queue share exhaustive retry-free native test shards with tree-keyed receipts", () => {
  assert.match(runtime, /native:\n    needs: classify\n    if: needs\.classify\.outputs\.run_native == 'true'\n    uses: \.\/\.github\/workflows\/runtime-native-tests\.yml/);
  assert.match(runtime, /paths:.*runtime-native-tests\.yml/);
  assert.match(runtime, /paths:.*runtime-reuse\.mjs/);
  assert.match(server, /runtime-native:\n    needs: classify\n    if: github\.event_name == 'merge_group' && needs\.classify\.outputs\.native_upstream_run_id == ''\n    uses: \.\/\.github\/workflows\/runtime-native-tests\.yml/);
  assert.match(native, /packages: --workspace --exclude mdbn-daemon --exclude mdbn-replica/);
  assert.match(native, /packages: -p mdbn-replica/);
  assert.match(native, /packages: -p mdbn-daemon\n/);
  assert.match(native, /packages: -p mdbn-daemon --features staging\n/);
  assert.match(native, /if: matrix.shard == 'daemon-staging'\n        run: \|\n          for features in staging,lab staging,local-rehearsal; do/);
  assert.match(native, /run: cargo test --locked \$\{\{ matrix.packages \}\}/);
  assert.match(native, /write-native-receipt/);
  assert.doesNotMatch(native, /--no-run|cargo-test.mjs|--lib/);
});

test("Runtime CI keeps every Worker-qualification job concluding success on main reuse", () => {
  assert.match(runtime, /permissions:\n  actions: read\n  contents: read/);
  assert.match(runtime, /run: node scripts\/ci\/runtime-reuse\.mjs classify-runtime/);
  assert.match(runtime, /run: node scripts\/ci\/runtime-reuse\.mjs write-runtime-receipt/);
  for (const jobName of CI_JOBS) {
    assert.ok(runtime.includes(`name: ${jobName}\n`), `missing job ${jobName}`);
  }
  for (const jobId of ["wasm", "sdk", "obsidian", "hosted-worker", "conformance"]) {
    const block = runtime.split(`\n  ${jobId}:\n`)[1].split(/\n  [a-z][\w-]+:\n/)[0];
    // Job itself must never be skipped, or ops / release-workers.mjs verifyJobs rejects it.
    assert.doesNotMatch(block.split("steps:\n")[0], /^\s+if:/m, `${jobId} must not skip at job level`);
    assert.match(block, /needs: classify/);
    assert.match(block, /if: needs\.classify\.outputs\.reused_run_id != ''\n        working-directory: \./);
  }
});

test("required Qualification enforces merge-queue native tests, selected PR suites, and push reuse", () => {
  const job = server.split("\n  qualification:\n")[1];
  assert.match(job, /      - runtime-native\n/);
  assert.match(job, /RUNTIME_NATIVE: \$\{\{ needs.runtime-native.result \}\}/);
  assert.match(job, /NATIVE_UPSTREAM_RUN_ID: \$\{\{ needs.classify.outputs.native_upstream_run_id \}\}/);
  const body = job.split("        run: |\n")[1].split("\n      - ")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const baseEnv = {
    CLASSIFY: "success",
    RUN_FULL: "true",
    UPSTREAM_RUN_ID: "",
    NATIVE_UPSTREAM_RUN_ID: "",
    RUN_CONTAINER: "true",
    RUN_LOG_POSTGRES: "true",
    RUN_LOG_DO: "true",
    RUN_SYSTEM_SUITES: "true",
    RUNTIME_NATIVE: "success",
    NODE: "success",
    CONTAINER: "success",
    LOG_POSTGRES: "success",
    LOG_DO: "success",
    SYSTEM_SUITES: "success"
  };

  // Merge queue requires runtime-native to succeed when not reusing an exact-tree upstream run.
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const command = spawnSync("bash", ["-e", "-c", body], {
      env: { ...process.env, ...baseEnv, GITHUB_EVENT_NAME: "merge_group", RUNTIME_NATIVE: result }
    });
    assert.equal(command.status, result === "success" ? 0 : 1, `merge_group runtime-native=${result}`);
  }
  // Merge queue accepts skipped runtime-native when classify verified an exact-tree upstream run.
  const reusedNative = spawnSync("bash", ["-e", "-c", body], {
    env: { ...process.env, ...baseEnv, GITHUB_EVENT_NAME: "merge_group", RUNTIME_NATIVE: "skipped", NATIVE_UPSTREAM_RUN_ID: "424242" }
  });
  assert.equal(reusedNative.status, 0);

  // Pull request with ci:full does not run runtime-native.
  const pullRequestFull = spawnSync("bash", ["-e", "-c", body], {
    env: { ...process.env, ...baseEnv, GITHUB_EVENT_NAME: "pull_request", RUNTIME_NATIVE: "skipped" }
  });
  assert.equal(pullRequestFull.status, 0);

  // Fast-lane pull request requires node and every suite selected by classify.
  const fastBase = {
    ...baseEnv,
    GITHUB_EVENT_NAME: "pull_request",
    RUN_FULL: "false",
    RUN_CONTAINER: "false",
    RUN_LOG_POSTGRES: "false",
    RUN_LOG_DO: "false",
    RUN_SYSTEM_SUITES: "false",
    RUNTIME_NATIVE: "skipped",
    CONTAINER: "skipped",
    LOG_POSTGRES: "skipped",
    LOG_DO: "skipped",
    SYSTEM_SUITES: "skipped"
  };
  assert.equal(spawnSync("bash", ["-e", "-c", body], { env: { ...process.env, ...fastBase } }).status, 0);
  assert.equal(spawnSync("bash", ["-e", "-c", body], { env: { ...process.env, ...fastBase, NODE: "failure" } }).status, 1);

  for (const [flag, resultKey, selectedValue] of [
    ["RUN_CONTAINER", "CONTAINER", "true"],
    ["RUN_LOG_POSTGRES", "LOG_POSTGRES", "true"],
    ["RUN_LOG_DO", "LOG_DO", "true"],
    ["RUN_SYSTEM_SUITES", "SYSTEM_SUITES", "true"]
  ]) {
    for (const [result, expected] of [["success", 0], ["failure", 1], ["cancelled", 1], ["skipped", 1]]) {
      const command = spawnSync("bash", ["-e", "-c", body], {
        env: { ...process.env, ...fastBase, [flag]: selectedValue, [resultKey]: result }
      });
      assert.equal(command.status, expected, `fast PR ${flag} ${resultKey}=${result}`);
    }
  }

  // Push reusing merge_group succeeds with all heavy jobs skipped, but fails if classify failed.
  const reusedPush = spawnSync("bash", ["-e", "-c", body], {
    env: { ...process.env, ...fastBase, GITHUB_EVENT_NAME: "push", UPSTREAM_RUN_ID: "999", NODE: "skipped" }
  });
  assert.equal(reusedPush.status, 0);
  const failedClassify = spawnSync("bash", ["-e", "-c", body], {
    env: { ...process.env, ...fastBase, GITHUB_EVENT_NAME: "push", UPSTREAM_RUN_ID: "999", CLASSIFY: "failure", NODE: "skipped" }
  });
  assert.equal(failedClassify.status, 1);
});
