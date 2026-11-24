import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  NATIVE_SHARDS,
  RUNTIME_CI_JOBS,
  RUNTIME_INPUT_PATHS,
  buildNativeReceipt,
  buildRuntimeReceipt,
  computeRuntimeInputs,
  expectedNativeJobNames,
  findReusableNativeRun,
  findReusableRuntimeRun,
  nativeArtifactName,
  runtimeArtifactName,
  verifyJobsSucceeded
} from "../ci/runtime-reuse.mjs";

const REPO = "mdbase-dev/mdbase-connect";

function createGitFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-reuse-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel, content) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  for (const path of RUNTIME_INPUT_PATHS) {
    if (path === "runtime") {
      write("runtime/Cargo.toml", "[workspace]\n");
      write("runtime/crates/core/src/lib.rs", "pub fn ok() {}\n");
    } else if (path === "config/next-trust") {
      write("config/next-trust/production.json", "{\"environment\":\"production\"}\n");
    } else {
      write(path, `// ${path}\n`);
    }
  }
  write("apps/editor/src/App.tsx", "export const App = () => null;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ci@example.test");
  git("config", "user.name", "CI");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return { dir, write, git };
}

test("computeRuntimeInputs hashes runtime inputs independently from unrelated repo files", (t) => {
  const { dir, write, git } = createGitFixture(t);
  const first = computeRuntimeInputs(dir);
  assert.match(first.tree, /^[0-9a-f]{40}$/);
  assert.match(first.runtimeInputsSha256, /^[0-9a-f]{64}$/);
  assert.match(first.runtimeWorkflowSha256, /^[0-9a-f]{64}$/);
  assert.match(first.nativeWorkflowSha256, /^[0-9a-f]{64}$/);

  // Editing an unrelated editor file changes the full Git tree, not runtime inputs.
  write("apps/editor/src/App.tsx", "export const App = () => 'updated';\n");
  git("add", ".");
  git("commit", "-q", "-m", "editor change");
  const afterEditor = computeRuntimeInputs(dir);
  assert.notEqual(afterEditor.tree, first.tree);
  assert.equal(afterEditor.runtimeInputsSha256, first.runtimeInputsSha256);

  // Editing any file under runtime/ changes both tree and runtime inputs.
  write("runtime/crates/core/src/lib.rs", "pub fn ok() { /* changed */ }\n");
  git("add", ".");
  git("commit", "-q", "-m", "runtime change");
  const afterRuntime = computeRuntimeInputs(dir);
  assert.notEqual(afterRuntime.tree, afterEditor.tree);
  assert.notEqual(afterRuntime.runtimeInputsSha256, afterEditor.runtimeInputsSha256);

  // Editing the workflow itself changes runtimeInputsSha256 and runtimeWorkflowSha256.
  write(".github/workflows/runtime-ci.yml", "# modified\n");
  git("add", ".");
  git("commit", "-q", "-m", "workflow change");
  const afterWorkflow = computeRuntimeInputs(dir);
  assert.notEqual(afterWorkflow.runtimeInputsSha256, afterRuntime.runtimeInputsSha256);
  assert.notEqual(afterWorkflow.runtimeWorkflowSha256, afterRuntime.runtimeWorkflowSha256);
});

function makeNativeFixture(inputs, overrides = {}) {
  const workflow = overrides.workflow ?? ".github/workflows/runtime-ci.yml";
  const runId = overrides.runId ?? 501;
  const runAttempt = overrides.runAttempt ?? 1;
  const artifact = {
    id: 901,
    name: nativeArtifactName(inputs.tree),
    expired: false,
    workflow_run: {
      id: runId,
      repository_id: 1,
      head_repository_id: 1
    },
    ...(overrides.artifact ?? {})
  };
  const run = {
    id: runId,
    run_attempt: runAttempt,
    path: workflow,
    event: overrides.event ?? "pull_request",
    head_branch: overrides.headBranch ?? "feature/runtime",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...(overrides.run ?? {})
  };
  const jobs = overrides.jobs ?? expectedNativeJobNames(workflow).map((name) => ({
    name, status: "completed", conclusion: "success"
  }));
  const receipt = {
    ...buildNativeReceipt(inputs, {
      GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: run.event,
      GITHUB_SHA: inputs.commit,
      GITHUB_RUN_ID: String(runId),
      GITHUB_RUN_ATTEMPT: String(runAttempt)
    }),
    ...(overrides.receipt ?? {})
  };
  return {
    api: (path) => {
      if (path.includes("/actions/artifacts?")) return { artifacts: [artifact] };
      if (path.endsWith(`/actions/runs/${runId}`)) return run;
      throw new Error(`unexpected API path ${path}`);
    },
    listJobs: () => jobs,
    downloadReceipt: () => receipt
  };
}

function makeRuntimeFixture(inputs, overrides = {}) {
  const runId = overrides.runId ?? 701;
  const runAttempt = overrides.runAttempt ?? 1;
  const artifact = {
    id: 951,
    name: runtimeArtifactName(inputs.runtimeInputsSha256),
    expired: false,
    workflow_run: {
      id: runId,
      repository_id: 1,
      head_repository_id: 1
    },
    ...(overrides.artifact ?? {})
  };
  const run = {
    id: runId,
    run_attempt: runAttempt,
    path: ".github/workflows/runtime-ci.yml",
    event: overrides.event ?? "pull_request",
    head_branch: overrides.headBranch ?? "feature/runtime",
    status: "completed",
    conclusion: "success",
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...(overrides.run ?? {})
  };
  const jobs = overrides.jobs ?? RUNTIME_CI_JOBS.map((name) => ({
    name, status: "completed", conclusion: "success"
  }));
  const receipt = {
    ...buildRuntimeReceipt(inputs, {
      GITHUB_REPOSITORY: REPO,
      GITHUB_EVENT_NAME: run.event,
      GITHUB_SHA: inputs.commit,
      GITHUB_RUN_ID: String(runId),
      GITHUB_RUN_ATTEMPT: String(runAttempt)
    }),
    ...(overrides.receipt ?? {})
  };
  return {
    api: (path) => {
      if (path.includes("/actions/artifacts?")) return { artifacts: [artifact] };
      if (path.endsWith(`/actions/runs/${runId}`)) return run;
      throw new Error(`unexpected API path ${path}`);
    },
    listJobs: () => jobs,
    downloadReceipt: () => receipt
  };
}

test("findReusableNativeRun accepts exact-tree Runtime CI and Server CI runs and rejects untrusted ones", (t) => {
  const { dir } = createGitFixture(t);
  const inputs = computeRuntimeInputs(dir);

  // Accepts verified same-repo Runtime CI PR run.
  const fromPr = findReusableNativeRun({ repo: REPO, inputs, ...makeNativeFixture(inputs) });
  assert.deepEqual(fromPr, {
    runId: "501", runAttempt: "1", workflow: ".github/workflows/runtime-ci.yml", event: "pull_request"
  });

  // Accepts verified Server CI merge_group run.
  const fromMq = findReusableNativeRun({
    repo: REPO,
    inputs,
    ...makeNativeFixture(inputs, { workflow: ".github/workflows/server-ci.yml", event: "merge_group" })
  });
  assert.deepEqual(fromMq, {
    runId: "501", runAttempt: "1", workflow: ".github/workflows/server-ci.yml", event: "merge_group"
  });

  // Rejects fork PRs, expired artifacts, missing/skipped shards, wrong tree/workflow/attempt, or Server CI PR runs.
  const rejections = [
    { artifact: { expired: true } },
    { artifact: { workflow_run: { id: 501, repository_id: 1, head_repository_id: 2 } } },
    { run: { head_repository: { full_name: "fork/mdbase-connect" } } },
    { run: { conclusion: "failure" } },
    { run: { status: "in_progress" } },
    { run: { event: "push", head_branch: "topic" } },
    { workflow: ".github/workflows/server-ci.yml", event: "pull_request" },
    { run: { path: ".github/workflows/other.yml" } },
    { jobs: expectedNativeJobNames(".github/workflows/runtime-ci.yml").slice(0, 3).map((name) => ({ name, status: "completed", conclusion: "success" })) },
    { jobs: expectedNativeJobNames(".github/workflows/runtime-ci.yml").map((name, i) => ({ name, status: "completed", conclusion: i === 0 ? "skipped" : "success" })) },
    { receipt: { executed: false } },
    { receipt: { tree: "0".repeat(40) } },
    { receipt: { run_attempt: "2" } },
    { receipt: { inputs: { native_workflow_sha256: "f".repeat(64), reuse_script_sha256: inputs.reuseScriptSha256 } } },
    { receipt: { inputs: { native_workflow_sha256: inputs.nativeWorkflowSha256, reuse_script_sha256: "f".repeat(64) } } }
  ];
  for (const [index, override] of rejections.entries()) {
    const result = findReusableNativeRun({ repo: REPO, inputs, ...makeNativeFixture(inputs, override) });
    assert.equal(result, null, `expected rejection #${index}`);
  }

  // Fails safe (returns null) if the artifact API throws.
  assert.equal(
    findReusableNativeRun({
      repo: REPO,
      inputs,
      api: () => { throw new Error("rate limited"); },
      listJobs: () => [],
      downloadReceipt: () => ({})
    }),
    null
  );
  assert.equal(NATIVE_SHARDS.length, 4);
  assert.equal(verifyJobsSucceeded([], ["a"]), false);
});

test("findReusableRuntimeRun accepts exact-inputs Runtime CI runs and rejects tampered or incomplete ones", (t) => {
  const { dir } = createGitFixture(t);
  const inputs = computeRuntimeInputs(dir);

  const fromPr = findReusableRuntimeRun({ repo: REPO, inputs, ...makeRuntimeFixture(inputs) });
  assert.deepEqual(fromPr, {
    runId: "701", runAttempt: "1", workflow: ".github/workflows/runtime-ci.yml", event: "pull_request"
  });

  const fromMain = findReusableRuntimeRun({
    repo: REPO,
    inputs,
    ...makeRuntimeFixture(inputs, { event: "push", headBranch: "main" })
  });
  assert.deepEqual(fromMain, {
    runId: "701", runAttempt: "1", workflow: ".github/workflows/runtime-ci.yml", event: "push"
  });

  const rejections = [
    { artifact: { expired: true } },
    { artifact: { workflow_run: { id: 701, repository_id: 1, head_repository_id: 2 } } },
    { run: { head_repository: { full_name: "fork/mdbase-connect" } } },
    { run: { path: ".github/workflows/server-ci.yml" } },
    { run: { event: "push", head_branch: "other" } },
    { run: { conclusion: "cancelled" } },
    { jobs: RUNTIME_CI_JOBS.slice(1).map((name) => ({ name, status: "completed", conclusion: "success" })) },
    { jobs: RUNTIME_CI_JOBS.map((name) => ({ name, status: "completed", conclusion: name === "Hosted worker" ? "skipped" : "success" })) },
    { jobs: [...RUNTIME_CI_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" })), { name: "Hosted worker", status: "completed", conclusion: "success" }] },
    { receipt: { executed: false } },
    { receipt: { runtime_inputs_sha256: "0".repeat(64) } },
    { receipt: { run_id: "999" } },
    { receipt: { inputs: { runtime_workflow_sha256: "f".repeat(64), native_workflow_sha256: inputs.nativeWorkflowSha256, reuse_script_sha256: inputs.reuseScriptSha256 } } }
  ];
  for (const [index, override] of rejections.entries()) {
    const result = findReusableRuntimeRun({ repo: REPO, inputs, ...makeRuntimeFixture(inputs, override) });
    assert.equal(result, null, `expected rejection #${index}`);
  }
});
