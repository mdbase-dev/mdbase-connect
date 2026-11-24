#!/usr/bin/env node
// Content-addressed CI qualification receipts and fail-closed reuse lookup for
// Runtime CI (keyed on exact runtime inputs) and native runtime tests (keyed on
// the exact Git tree). Never trusts fork runs, skipped jobs, or unverified runs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_INT = /^[1-9][0-9]*$/;

export const NATIVE_SHARDS = Object.freeze([
  "workspace",
  "replica",
  "daemon",
  "daemon-staging"
]);

export const RUNTIME_CI_JOBS = Object.freeze([
  "Worker publication contract",
  "wasm (build, size budget, determinism)",
  "sdk execution",
  "obsidian runtime execution",
  "Hosted worker",
  "logsvc DO (wasm32, local conformance, restart replay)"
]);

// Every Git path read by Runtime CI's non-native jobs (publication, wasm, sdk,
// obsidian, hosted-worker, conformance). Directory paths hash their entire Git
// subtree OID via `git rev-parse HEAD:<path>`.
export const RUNTIME_INPUT_PATHS = Object.freeze([
  ".github/actions/post-performance",
  ".github/workflows/release-workers.yml",
  ".github/workflows/runtime-ci.yml",
  ".github/workflows/runtime-native-tests.yml",
  "apps/editor/scripts/bundle-assets.mjs",
  "config/next-trust",
  "config/release-components.json",
  "runtime",
  "scripts/ci/prefetch-worker-tools.mjs",
  "scripts/ci/runtime-reuse.mjs",
  "scripts/lib/github-release-download.mjs",
  "scripts/lib/sdk-publication.mjs",
  "scripts/performance-report.mjs",
  "scripts/release-workers.mjs",
  "scripts/release-workers.test.mjs",
  "scripts/sdk-publication.mjs"
]);

export const nativeArtifactName = (tree) => `runtime-native-qualification-${tree}`;
export const runtimeArtifactName = (digest) => `runtime-qualification-${digest}`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function defaultExec(command, args, options = {}) {
  return execFileSync(command, args, { maxBuffer: 16 * 1024 * 1024, stdio: "pipe", ...options });
}

function gitOid(root, spec, exec = defaultExec) {
  const oid = exec("git", ["rev-parse", "--verify", spec], { cwd: root, encoding: "utf8" }).trim();
  if (!SHA1.test(oid)) throw new Error(`Invalid Git OID for ${spec}: ${oid}`);
  return oid;
}

function blobSha256(root, path, exec = defaultExec) {
  const bytes = exec("git", ["cat-file", "blob", `HEAD:${path}`], { cwd: root });
  return sha256(bytes);
}

export function computeRuntimeInputs(root = ROOT, exec = defaultExec) {
  const commit = gitOid(root, "HEAD", exec);
  const tree = gitOid(root, "HEAD^{tree}", exec);
  const lines = RUNTIME_INPUT_PATHS.map((path) => `${gitOid(root, `HEAD:${path}`, exec)}  ${path}`);
  const runtimeInputsSha256 = sha256(`${lines.join("\n")}\n`);
  const runtimeWorkflowSha256 = blobSha256(root, ".github/workflows/runtime-ci.yml", exec);
  const nativeWorkflowSha256 = blobSha256(root, ".github/workflows/runtime-native-tests.yml", exec);
  const reuseScriptSha256 = blobSha256(root, "scripts/ci/runtime-reuse.mjs", exec);
  return {
    commit,
    tree,
    runtimeInputsSha256,
    runtimeWorkflowSha256,
    nativeWorkflowSha256,
    reuseScriptSha256
  };
}

export function expectedNativeJobNames(workflowPath) {
  if (workflowPath === ".github/workflows/runtime-ci.yml") {
    return NATIVE_SHARDS.map((shard) => `native / native tests (${shard})`);
  }
  if (workflowPath === ".github/workflows/server-ci.yml") {
    return NATIVE_SHARDS.map((shard) => `runtime-native / native tests (${shard})`);
  }
  return null;
}

export function verifyJobsSucceeded(jobs, requiredNames) {
  if (!Array.isArray(jobs)) return false;
  for (const name of requiredNames) {
    const found = jobs.filter((job) => job && job.name === name);
    if (found.length !== 1 || found[0].status !== "completed" || found[0].conclusion !== "success") {
      return false;
    }
  }
  return true;
}

function isSameRepoArtifact(artifact) {
  const run = artifact?.workflow_run;
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0) return false;
  if (run.repository_id != null && run.head_repository_id != null
      && run.head_repository_id !== run.repository_id) {
    return false;
  }
  return true;
}

function isTrustedRun(run, repo, allowedEvents) {
  if (!run || typeof run !== "object") return false;
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  if (run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) return false;
  if (!allowedEvents.includes(run.event)) return false;
  if ((run.event === "push" || run.event === "workflow_dispatch") && run.head_branch !== "main") {
    return false;
  }
  if (!Number.isSafeInteger(run.id) || run.id <= 0) return false;
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) return false;
  return true;
}

export function buildNativeReceipt(inputs, env) {
  return {
    schema_version: 1,
    kind: "runtime-native-qualification",
    executed: true,
    repository: env.GITHUB_REPOSITORY,
    event: env.GITHUB_EVENT_NAME,
    commit: env.GITHUB_SHA,
    tree: inputs.tree,
    run_id: String(env.GITHUB_RUN_ID),
    run_attempt: String(env.GITHUB_RUN_ATTEMPT),
    inputs: {
      native_workflow_sha256: inputs.nativeWorkflowSha256,
      reuse_script_sha256: inputs.reuseScriptSha256
    }
  };
}

export function buildRuntimeReceipt(inputs, env) {
  return {
    schema_version: 1,
    kind: "runtime-qualification",
    executed: true,
    repository: env.GITHUB_REPOSITORY,
    workflow: ".github/workflows/runtime-ci.yml",
    event: env.GITHUB_EVENT_NAME,
    commit: env.GITHUB_SHA,
    tree: inputs.tree,
    runtime_inputs_sha256: inputs.runtimeInputsSha256,
    run_id: String(env.GITHUB_RUN_ID),
    run_attempt: String(env.GITHUB_RUN_ATTEMPT),
    inputs: {
      runtime_workflow_sha256: inputs.runtimeWorkflowSha256,
      native_workflow_sha256: inputs.nativeWorkflowSha256,
      reuse_script_sha256: inputs.reuseScriptSha256
    }
  };
}

export function validateNativeReceipt(receipt, { repo, inputs, run }) {
  return Boolean(
    receipt && typeof receipt === "object"
    && receipt.schema_version === 1
    && receipt.kind === "runtime-native-qualification"
    && receipt.executed === true
    && receipt.repository === repo
    && receipt.tree === inputs.tree && SHA1.test(receipt.tree)
    && receipt.run_id === String(run.id) && POSITIVE_INT.test(receipt.run_id)
    && receipt.run_attempt === String(run.run_attempt) && POSITIVE_INT.test(receipt.run_attempt)
    && receipt.inputs?.native_workflow_sha256 === inputs.nativeWorkflowSha256
    && SHA256.test(receipt.inputs?.native_workflow_sha256)
    && receipt.inputs?.reuse_script_sha256 === inputs.reuseScriptSha256
    && SHA256.test(receipt.inputs?.reuse_script_sha256)
  );
}

export function validateRuntimeReceipt(receipt, { repo, inputs, run }) {
  return Boolean(
    receipt && typeof receipt === "object"
    && receipt.schema_version === 1
    && receipt.kind === "runtime-qualification"
    && receipt.executed === true
    && receipt.repository === repo
    && receipt.workflow === ".github/workflows/runtime-ci.yml"
    && receipt.runtime_inputs_sha256 === inputs.runtimeInputsSha256
    && SHA256.test(receipt.runtime_inputs_sha256)
    && receipt.run_id === String(run.id) && POSITIVE_INT.test(receipt.run_id)
    && receipt.run_attempt === String(run.run_attempt) && POSITIVE_INT.test(receipt.run_attempt)
    && receipt.inputs?.runtime_workflow_sha256 === inputs.runtimeWorkflowSha256
    && SHA256.test(receipt.inputs?.runtime_workflow_sha256)
    && receipt.inputs?.native_workflow_sha256 === inputs.nativeWorkflowSha256
    && SHA256.test(receipt.inputs?.native_workflow_sha256)
    && receipt.inputs?.reuse_script_sha256 === inputs.reuseScriptSha256
    && SHA256.test(receipt.inputs?.reuse_script_sha256)
  );
}

export function findReusableNativeRun({ repo, inputs, api, listJobs, downloadReceipt, log = () => {} }) {
  const expectedName = nativeArtifactName(inputs.tree);
  let response;
  try {
    response = api(`repos/${repo}/actions/artifacts?name=${encodeURIComponent(expectedName)}&per_page=10`);
  } catch (error) {
    log(`native reuse lookup skipped: ${error.message}`);
    return null;
  }
  const artifacts = Array.isArray(response?.artifacts) ? response.artifacts : [];
  for (const artifact of artifacts) {
    if (artifact?.expired !== false || artifact.name !== expectedName || !isSameRepoArtifact(artifact)) {
      continue;
    }
    try {
      const run = api(`repos/${repo}/actions/runs/${artifact.workflow_run.id}`);
      const requiredJobs = expectedNativeJobNames(run?.path);
      if (!requiredJobs) continue;
      const allowedEvents = run.path === ".github/workflows/server-ci.yml"
        ? ["merge_group", "push"]
        : ["pull_request", "merge_group", "push", "workflow_dispatch"];
      if (!isTrustedRun(run, repo, allowedEvents)) continue;
      const jobs = listJobs(run.id, run.run_attempt);
      if (!verifyJobsSucceeded(jobs, requiredJobs)) continue;
      const receipt = downloadReceipt(artifact.id, "runtime-native-qualification.json");
      if (!validateNativeReceipt(receipt, { repo, inputs, run })) continue;
      return {
        runId: String(run.id),
        runAttempt: String(run.run_attempt),
        workflow: run.path,
        event: run.event
      };
    } catch (error) {
      log(`native reuse candidate ${artifact.workflow_run.id} rejected: ${error.message}`);
    }
  }
  return null;
}

export function findReusableRuntimeRun({ repo, inputs, api, listJobs, downloadReceipt, log = () => {} }) {
  const expectedName = runtimeArtifactName(inputs.runtimeInputsSha256);
  let response;
  try {
    response = api(`repos/${repo}/actions/artifacts?name=${encodeURIComponent(expectedName)}&per_page=10`);
  } catch (error) {
    log(`runtime reuse lookup skipped: ${error.message}`);
    return null;
  }
  const artifacts = Array.isArray(response?.artifacts) ? response.artifacts : [];
  for (const artifact of artifacts) {
    if (artifact?.expired !== false || artifact.name !== expectedName || !isSameRepoArtifact(artifact)) {
      continue;
    }
    try {
      const run = api(`repos/${repo}/actions/runs/${artifact.workflow_run.id}`);
      if (run?.path !== ".github/workflows/runtime-ci.yml") continue;
      if (!isTrustedRun(run, repo, ["pull_request", "merge_group", "push", "workflow_dispatch"])) continue;
      const jobs = listJobs(run.id, run.run_attempt);
      if (!verifyJobsSucceeded(jobs, RUNTIME_CI_JOBS)) continue;
      const receipt = downloadReceipt(artifact.id, "runtime-qualification.json");
      if (!validateRuntimeReceipt(receipt, { repo, inputs, run })) continue;
      return {
        runId: String(run.id),
        runAttempt: String(run.run_attempt),
        workflow: run.path,
        event: run.event
      };
    } catch (error) {
      log(`runtime reuse candidate ${artifact.workflow_run.id} rejected: ${error.message}`);
    }
  }
  return null;
}

function createGithubClient(repo) {
  const api = (path) => {
    const stdout = defaultExec("gh", ["api", path], { encoding: "utf8", timeout: 30000 });
    return JSON.parse(stdout);
  };
  const listJobs = (runId, runAttempt) => {
    const jobs = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = api(`repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
      const batch = Array.isArray(response?.jobs) ? response.jobs : [];
      jobs.push(...batch);
      if (batch.length < 100) return jobs;
    }
    throw new Error("Run job pagination limit reached");
  };
  const downloadReceipt = (artifactId, filename) => {
    const dir = mkdtempSync(join(tmpdir(), "mdbase-ci-receipt-"));
    try {
      const zipPath = join(dir, "artifact.zip");
      const zipBytes = defaultExec("gh", ["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`], {
        timeout: 60000
      });
      writeFileSync(zipPath, zipBytes);
      const text = defaultExec("python3", [
        "-c",
        "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); names = z.namelist(); assert names == [sys.argv[2]], names; assert z.getinfo(sys.argv[2]).file_size <= 65536; sys.stdout.buffer.write(z.read(sys.argv[2]))",
        zipPath,
        filename
      ], { encoding: "utf8", timeout: 15000 });
      return JSON.parse(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { api, listJobs, downloadReceipt };
}

function writeOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`).join(""));
}

function main() {
  const [command, targetPath] = process.argv.slice(2);
  const env = process.env;
  const inputs = computeRuntimeInputs(ROOT);
  const log = (message) => console.error(message);

  if (command === "write-native-receipt") {
    if (!targetPath) throw new Error("Expected output receipt path");
    const receipt = buildNativeReceipt(inputs, env);
    writeFileSync(targetPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeOutputs({
      tree: inputs.tree,
      artifact_name: nativeArtifactName(inputs.tree)
    });
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (command === "write-runtime-receipt") {
    if (!targetPath) throw new Error("Expected output receipt path");
    const receipt = buildRuntimeReceipt(inputs, env);
    writeFileSync(targetPath, `${JSON.stringify(receipt, null, 2)}\n`);
    writeOutputs({
      tree: inputs.tree,
      runtime_inputs_sha256: inputs.runtimeInputsSha256,
      artifact_name: runtimeArtifactName(inputs.runtimeInputsSha256)
    });
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (command === "classify-native") {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("GITHUB_REPOSITORY is required");
    const client = createGithubClient(repo);
    const reused = findReusableNativeRun({ repo, inputs, ...client, log });
    const outputs = {
      tree: inputs.tree,
      native_upstream_run_id: reused?.runId ?? ""
    };
    writeOutputs(outputs);
    console.log(JSON.stringify({ ...outputs, reused }, null, 2));
    return;
  }

  if (command === "classify-runtime") {
    const repo = env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("GITHUB_REPOSITORY is required");
    let reused = null;
    let nativeReused = null;
    // Only reuse on main pushes; pull_request and workflow_dispatch always run fresh.
    if (env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main") {
      const client = createGithubClient(repo);
      reused = findReusableRuntimeRun({ repo, inputs, ...client, log });
      nativeReused = findReusableNativeRun({ repo, inputs, ...client, log });
    }
    const outputs = {
      tree: inputs.tree,
      runtime_inputs_sha256: inputs.runtimeInputsSha256,
      reused_run_id: reused?.runId ?? "",
      native_reused_run_id: nativeReused?.runId ?? "",
      run_native: nativeReused ? "false" : "true"
    };
    writeOutputs(outputs);
    console.log(JSON.stringify({ ...outputs, reused, nativeReused }, null, 2));
    return;
  }

  throw new Error("Usage: runtime-reuse.mjs classify-runtime|classify-native|write-runtime-receipt|write-native-receipt");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
