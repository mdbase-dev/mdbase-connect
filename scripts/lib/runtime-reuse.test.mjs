import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  validateNativeReceipt,
  verifyJobsSucceeded
} from "../ci/runtime-reuse.mjs";

const REPO = "mdbase-dev/mdbase-connect";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
    } else if (path === ".github/actions/post-performance") {
      write(".github/actions/post-performance/action.yml", "name: Post performance\n");
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

// Minimal indentation-aware parser for GitHub Actions workflow jobs, defaults,
// and step fields (`uses`, `working-directory`, `run`, `with`).
function parseWorkflowJobs(yamlText) {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const indentOf = (line) => line.length - line.trimStart().length;
  const unquote = (value) => {
    const trimmed = value.trim();
    if ((trimmed.startsWith("'") && trimmed.endsWith("'"))
        || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }
    return trimmed.replace(/\s+#.*$/, "").trim();
  };
  const readBlock = (startIndex, baseIndent) => {
    const block = [];
    let i = startIndex;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!next.trim()) { block.push(""); i += 1; continue; }
      if (indentOf(next) <= baseIndent) break;
      block.push(next);
      i += 1;
    }
    const minIndent = block.filter((l) => l.trim()).reduce((min, l) => Math.min(min, indentOf(l)), Infinity);
    const dedented = block.map((l) => (l.trim() ? l.slice(minIndent) : "")).join("\n");
    return { text: dedented, endIndex: i };
  };

  let workflowDefaultCwd = ".";
  const topDefaultsMatch = yamlText.match(/^defaults:\n  run:\n    working-directory:\s*(.+)$/m);
  if (topDefaultsMatch) workflowDefaultCwd = unquote(topDefaultsMatch[1]);

  const jobsStart = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsStart, -1, "workflow missing jobs: section");

  const jobs = {};
  let currentJob = null;
  let inSteps = false;
  let currentStep = null;
  let inWith = false;
  let stepBaseIndent = 0;

  for (let i = jobsStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const ind = indentOf(line);
    if (ind === 0) break;

    if (ind === 2 && /^  ([A-Za-z0-9_-]+):\s*$/.test(line)) {
      const jobId = line.trim().slice(0, -1);
      currentJob = { id: jobId, defaultCwd: workflowDefaultCwd, uses: null, steps: [] };
      jobs[jobId] = currentJob;
      inSteps = false;
      currentStep = null;
      inWith = false;
      continue;
    }
    if (!currentJob) continue;

    if (ind === 4 && line.startsWith("    uses:")) {
      currentJob.uses = unquote(line.slice("    uses:".length));
      continue;
    }
    if (ind === 8 && !inSteps && line.startsWith("        working-directory:")) {
      currentJob.defaultCwd = unquote(line.slice("        working-directory:".length));
      continue;
    }
    if (ind === 4 && line.trim() === "steps:") {
      inSteps = true;
      currentStep = null;
      inWith = false;
      continue;
    }
    if (!inSteps) continue;

    const stepItem = /^(\s+)-\s+(.*)$/.exec(line);
    if (stepItem && stepItem[1].length === 6) {
      currentStep = { uses: null, workingDirectory: null, run: null, with: {} };
      currentJob.steps.push(currentStep);
      stepBaseIndent = 6;
      inWith = false;
      const rest = stepItem[2];
      const kv = /^([A-Za-z0-9_-]+):(.*)$/.exec(rest);
      if (kv) {
        const [, key, rawVal] = kv;
        const val = rawVal.trim();
        if (key === "uses") currentStep.uses = unquote(val);
        else if (key === "working-directory") currentStep.workingDirectory = unquote(val);
        else if (key === "run") {
          if (/^[|>][-+]?$/.test(val)) {
            const { text, endIndex } = readBlock(i, stepBaseIndent);
            currentStep.run = val.startsWith(">") ? text.replace(/\n+/g, " ") : text;
            i = endIndex;
          } else {
            currentStep.run = unquote(val);
          }
        }
      }
      continue;
    }

    if (!currentStep) continue;
    if (ind === 8) {
      inWith = false;
      const kv = /^\s+([A-Za-z0-9_-]+):(.*)$/.exec(line);
      if (!kv) continue;
      const [, key, rawVal] = kv;
      const val = rawVal.trim();
      if (key === "uses") currentStep.uses = unquote(val);
      else if (key === "working-directory") currentStep.workingDirectory = unquote(val);
      else if (key === "with") inWith = true;
      else if (key === "run") {
        if (/^[|>][-+]?$/.test(val)) {
          const { text, endIndex } = readBlock(i, 8);
          currentStep.run = val.startsWith(">") ? text.replace(/\n+/g, " ") : text;
          i = endIndex;
        } else {
          currentStep.run = unquote(val);
        }
      }
    } else if (inWith && ind === 10) {
      const kv = /^\s+([A-Za-z0-9_-]+):(.*)$/.exec(line);
      if (!kv) continue;
      const [, key, rawVal] = kv;
      const val = rawVal.trim();
      if (/^[|>][-+]?$/.test(val)) {
        const { text, endIndex } = readBlock(i, 10);
        currentStep.with[key] = text;
        i = endIndex;
      } else {
        currentStep.with[key] = unquote(val);
      }
    }
  }
  return jobs;
}

function normalizeRepoPath(baseCwd, rawPath) {
  let cleaned = rawPath.replace(/^\$\{\{\s*github\.workspace\s*\}\}\/?/, "");
  if (rawPath.startsWith("${{")) {
    return posix.normalize(cleaned || ".");
  }
  const base = baseCwd === "." ? "" : baseCwd;
  return posix.normalize(base ? `${base}/${cleaned}` : cleaned);
}

function isCoveredByRuntimeInputs(repoRelativePath) {
  const normalized = posix.normalize(repoRelativePath).replace(/\/+$/, "");
  return RUNTIME_INPUT_PATHS.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function collectTransitiveLocalImports(repoRelativeFile, seen = new Set()) {
  if (seen.has(repoRelativeFile)) return seen;
  seen.add(repoRelativeFile);
  if (!/\.[cm]?[jt]s$/.test(repoRelativeFile)) return seen;
  const fullPath = join(REPO_ROOT, repoRelativeFile);
  if (!existsSync(fullPath)) return seen;
  const source = readFileSync(fullPath, "utf8");
  const patterns = [
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["'](\.[^"']+)["']/g,
    /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g,
    /\brequire\(\s*["'](\.[^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const target = posix.normalize(posix.join(posix.dirname(repoRelativeFile), match[1]));
      if (existsSync(join(REPO_ROOT, target))) {
        collectTransitiveLocalImports(target, seen);
      }
    }
  }
  return seen;
}

test("guard: every path outside runtime/ read by runtime-ci.yml is covered by RUNTIME_INPUT_PATHS", () => {
  const runtimeYaml = readFileSync(join(REPO_ROOT, ".github/workflows/runtime-ci.yml"), "utf8");
  const jobs = parseWorkflowJobs(runtimeYaml);

  // Sanity check that the parser found all expected jobs.
  assert.deepEqual(
    Object.keys(jobs).sort(),
    ["classify", "conformance", "hosted-worker", "native", "obsidian", "publication", "record-qualification", "sdk", "wasm"]
  );
  // Only `native` delegates to runtime-native-tests.yml (keyed on full HEAD^{tree}).
  assert.equal(jobs.native.uses, "./.github/workflows/runtime-native-tests.yml");

  const referencedOutsideRuntime = new Map();
  const record = (repoPath, source) => {
    const normalized = posix.normalize(repoPath).replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.startsWith("/")) return;
    if (normalized === "runtime" || normalized.startsWith("runtime/")) return;
    if (!referencedOutsideRuntime.has(normalized)) referencedOutsideRuntime.set(normalized, source);
  };

  for (const job of Object.values(jobs)) {
    if (job.id === "native") continue;
    assert.equal(job.uses, null, `unexpected workflow_call on non-native job ${job.id}`);

    for (const [stepIndex, step] of job.steps.entries()) {
      const label = `${job.id}[${stepIndex}]`;
      const effectiveCwd = step.workingDirectory
        ? normalizeRepoPath(".", step.workingDirectory)
        : normalizeRepoPath(".", job.defaultCwd);

      // 1. Local composite actions (`uses: ./...`).
      if (step.uses?.startsWith("./")) {
        record(step.uses.slice(2), `${label} uses:${step.uses}`);
      }

      // 2. `hashFiles(...)` expressions anywhere in `with` or `run`.
      const exprTexts = [...Object.values(step.with), step.run ?? ""];
      for (const text of exprTexts) {
        for (const match of text.matchAll(/hashFiles\(([^)]+)\)/g)) {
          for (const arg of match[1].matchAll(/['"]([^'"]+)['"]/g)) {
            const pattern = arg[1].replace(/^!/, "");
            const staticRoot = pattern.split(/[*?[\]]/)[0].replace(/\/+$/, "");
            if (staticRoot) record(staticRoot, `${label} hashFiles(${pattern})`);
          }
        }
      }

      // 3. Cache / workspace paths in `with`.
      if (step.with["cache-dependency-path"]) {
        for (const line of step.with["cache-dependency-path"].split("\n")) {
          const entry = line.trim();
          if (entry) record(entry, `${label} cache-dependency-path`);
        }
      }
      if (step.with.workspaces) {
        for (const line of step.with.workspaces.split("\n")) {
          const [ws] = line.split("->").map((part) => part.trim());
          if (ws) record(ws, `${label} workspaces`);
        }
      }
      if (step.uses?.startsWith("actions/cache@") && step.with.path) {
        for (const line of step.with.path.split("\n")) {
          const entry = line.trim();
          if (entry && !entry.startsWith("~") && !entry.startsWith("$")) {
            record(entry, `${label} cache path`);
          }
        }
      }

      // 4. `run:` commands: resolve every existing repo path token against effectiveStepCwd,
      //    and forbid root-level toolchain/package-manager invocations outside runtime/.
      if (step.run) {
        if (effectiveCwd === ".") {
          assert.doesNotMatch(
            step.run,
            /(?:^|[;&|\n]\s*)(?:rustup|cargo|pnpm|npm)\b/,
            `${label} runs toolchain/package manager at repo root; update RUNTIME_INPUT_PATHS and this guard`
          );
        }
        const tokens = step.run
          .replace(/['"`]/g, " ")
          .split(/\s+/)
          .map((token) => token.replace(/^[;|&()]+|[;|&()]+$/g, ""))
          .filter(Boolean);
        for (const token of tokens) {
          if (token.startsWith("-") || token.startsWith("$") || token.includes("://") || token.includes("${{")) {
            continue;
          }
          // Skip flag=value prefixes except path values like `--wasm name=path`.
          const candidate = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
          if (!candidate || candidate.startsWith("/") || candidate.startsWith("$")) continue;
          const resolved = normalizeRepoPath(effectiveCwd, candidate);
          if (resolved !== "." && !resolved.startsWith("..") && existsSync(join(REPO_ROOT, resolved))) {
            record(resolved, `${label} run token ${candidate} (cwd=${effectiveCwd})`);
          }
        }
      }
    }
  }

  // Expand transitive static JS/MJS imports for every discovered file outside runtime/.
  for (const [filePath, source] of [...referencedOutsideRuntime.entries()]) {
    for (const imported of collectTransitiveLocalImports(filePath)) {
      record(imported, `transitive import of ${filePath} (from ${source})`);
    }
  }

  // Verify the guard actually discovered concrete external inputs (not vacuously empty).
  assert.ok(referencedOutsideRuntime.has("scripts/performance-report.mjs"), "guard must discover performance-report.mjs");
  assert.ok(referencedOutsideRuntime.has("apps/editor/scripts/bundle-assets.mjs"), "guard must discover transitive bundle-assets.mjs");
  assert.ok(referencedOutsideRuntime.has(".github/actions/post-performance"), "guard must discover post-performance action");
  assert.ok(referencedOutsideRuntime.has("scripts/sdk-publication.mjs"), "guard must discover sdk-publication.mjs");
  assert.ok(referencedOutsideRuntime.has("scripts/release-workers.test.mjs"), "guard must discover release-workers.test.mjs");

  const uncovered = [...referencedOutsideRuntime.entries()]
    .filter(([filePath]) => !isCoveredByRuntimeInputs(filePath));
  assert.deepEqual(
    uncovered,
    [],
    `runtime-ci.yml reads paths outside runtime/ missing from RUNTIME_INPUT_PATHS: ${JSON.stringify(uncovered)}`
  );
});

test("guard: runtime-native-tests.yml touches paths outside runtime/ and its receipt stays keyed on full HEAD^{tree}", (t) => {
  const nativeYaml = readFileSync(join(REPO_ROOT, ".github/workflows/runtime-native-tests.yml"), "utf8");
  const jobs = parseWorkflowJobs(nativeYaml);

  assert.deepEqual(Object.keys(jobs).sort(), ["native", "receipt"]);
  // Confirm daemon shard runs root pnpm + test/system/run.mjs (outside runtime/),
  // which is why native reuse MUST key on the full repo Git tree (`HEAD^{tree}`).
  const daemonRootStep = jobs.native.steps.find(
    (step) => step.workingDirectory === "." && step.run?.includes("test/system/run.mjs")
  );
  assert.ok(daemonRootStep, "expected daemon shard to exercise root test/system/run.mjs");
  assert.match(daemonRootStep.run, /pnpm install --frozen-lockfile/);

  // Confirm receipt job writes the tree-keyed native receipt (not runtime-inputs receipt).
  assert.ok(
    jobs.receipt.steps.some((step) => step.run?.includes("node scripts/ci/runtime-reuse.mjs write-native-receipt")),
    "receipt job must invoke write-native-receipt"
  );

  // Confirm native receipt and lookup are strictly bound to full HEAD^{tree}.
  const { dir, write, git } = createGitFixture(t);
  const before = computeRuntimeInputs(dir);
  write("apps/editor/src/App.tsx", "export const App = () => 'changed-outside-runtime';\n");
  git("add", ".");
  git("commit", "-q", "-m", "unrelated root change");
  const after = computeRuntimeInputs(dir);

  assert.equal(after.runtimeInputsSha256, before.runtimeInputsSha256);
  assert.notEqual(after.tree, before.tree);
  assert.notEqual(nativeArtifactName(after.tree), nativeArtifactName(before.tree));

  const receipt = buildNativeReceipt(before, {
    GITHUB_REPOSITORY: REPO,
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_SHA: before.commit,
    GITHUB_RUN_ID: "501",
    GITHUB_RUN_ATTEMPT: "1"
  });
  assert.equal(receipt.tree, before.tree);
  assert.equal("runtime_inputs_sha256" in receipt, false);
  assert.equal(
    validateNativeReceipt(receipt, { repo: REPO, inputs: after, run: { id: 501, run_attempt: 1 } }),
    false,
    "native receipt for an earlier HEAD^{tree} must not validate after any repo change"
  );
});
