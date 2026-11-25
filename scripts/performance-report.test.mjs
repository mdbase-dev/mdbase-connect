import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { cpuSlug, performanceReport, performanceSuite, runtimeMetrics, sizeMetrics } from "./performance-report.mjs";

test("independent WASM and SDK jobs cannot replace each other's reports in the same workflow run", () => {
  assert.equal(performanceSuite({ app: "apps/editor" }), "sizes");
  assert.equal(performanceSuite({ wasm: ["runtime=runtime.wasm"] }), "sizes.wasm");
  assert.equal(performanceSuite({ sdkPackage: "sdk.tgz" }), "sizes.sdk");
  assert.equal(performanceSuite({ runtime: "report.json" }), "runtime-v1");
  assert.throws(() => performanceSuite({}));
  assert.throws(() => performanceSuite({ wasm: [] }));
  assert.throws(() => performanceSuite({ wasm: ["runtime=runtime.wasm"], sdkPackage: "sdk.tgz" }));
});

test("size history measures exact initial assets, deduplicates preloads, and rejects absent inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "performance-fixture-"));
  try {
    await mkdir(join(root, "dist/assets"), { recursive: true });
    await writeFile(join(root, "dist/index.html"), '<script type="module" src="/assets/main.js"></script><link rel="modulepreload" href="/assets/main.js"><link rel="stylesheet" href="/assets/main.css">');
    await writeFile(join(root, "dist/assets/main.js"), "export default 1;");
    await writeFile(join(root, "dist/assets/main.css"), "body{}");
    await writeFile(join(root, "app.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(join(root, "sdk.tgz"), gzipSync("tar fixture"));
    const result = await sizeMetrics({ app: root, wasm: [{ name: "app-runtime", path: join(root, "app.wasm") }], sdkPackage: join(root, "sdk.tgz") });
    assert.equal(result.find((metric) => metric.name === "editor.initial-js.gzip").value, gzipSync("export default 1;", { level: 9 }).length);
    assert.equal(result.find((metric) => metric.name === "app-runtime.raw").value, 8);
    assert.equal(result.find((metric) => metric.name === "sdk.package").value, gzipSync("tar fixture").length);
    await assert.rejects(sizeMetrics({}), /No performance inputs/);
    await writeFile(join(root, "dist/index.html"), '<script src="https://example.com/main.js"></script><link href="/assets/main.css">');
    await assert.rejects(sizeMetrics({ app: root }), /local/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runtime history stores normalized minimums and medians, not machine identities or raw timings", () => {
  const source = { meta: { calibration_ms: 50, debug_build: false, cpu: "not retained" },
    results: [{ scenario: "native.open_cold", size: 1000, n: 3, min_ms: 10, p50_ms: 15, note: "not retained" }] };
  const metrics = runtimeMetrics(source);
  assert.deepEqual(metrics, [{ name: "native.open_cold.1000.min", unit: "ratio", value: 0.2, samples: 3 },
    { name: "native.open_cold.1000.median", unit: "ratio", value: 0.3, samples: 3 }]);
  assert.ok(!JSON.stringify(metrics).includes("not retained"));
  for (const calibration_ms of [0, -1, null, Infinity]) assert.throws(() => runtimeMetrics({ ...source, meta: { ...source.meta, calibration_ms } }));
  assert.throws(() => runtimeMetrics({ ...source, meta: { ...source.meta, debug_build: true } }));
  assert.throws(() => runtimeMetrics({ ...source, results: [...source.results, ...source.results] }));
});

test("untimed runtime refusals do not discard measured scenarios or invent zero observations", () => {
  const measured = { scenario: "native.open_cold", size: 1000, n: 3, min_ms: 10, p50_ms: 15 };
  const untimed = { scenario: "bases.all_tasks", size: 1000, n: 0, min_ms: null, p50_ms: null, note: "failed: not retained" };
  const source = { meta: { calibration_ms: 50, debug_build: false }, results: [untimed, measured] };
  assert.deepEqual(runtimeMetrics(source), runtimeMetrics({ ...source, results: [measured] }));
  assert.throws(() => runtimeMetrics({ ...source, results: [untimed] }));
  assert.throws(() => runtimeMetrics({ ...source, results: [{ ...untimed, min_ms: 0, p50_ms: 0 }] }));
  assert.throws(() => runtimeMetrics({ ...source, results: [{ ...measured, min_ms: null }] }));
});

test("provenance requires the exact main checkout and refuses PR execution", () => {
  const commit = "a".repeat(40);
  const source = { commit, commitAt: "2026-11-15T12:00:00Z" };
  const env = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: commit, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" };
  assert.equal(performanceReport([], "sizes", source, env).commit, commit);
  for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_SHA: "b".repeat(40) }, { GITHUB_RUN_ID: "0" }, { GITHUB_REF: "refs/pull/1/merge" }]) {
    assert.throws(() => performanceReport([], "sizes", source, { ...env, ...patch }));
  }
});

test("runtime performance reports distinguish runner hardware using ops-compatible CPU slugs", () => {
  const BENCHMARK_WORD = /^[a-z0-9][a-z0-9._-]{0,119}$/;
  const cases = [
    ["AMD EPYC 9V74 80-Core Processor", "amd-epyc-9v74"],
    ["AMD EPYC 7763 64-Core Processor", "amd-epyc-7763"],
    ["Intel(R) Xeon(R) 6975P-C", "intel-xeon-6975p-c"],
    ["Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz", "intel-xeon-platinum-8370c"],
    ["Intel(R) Xeon(R) CPU E5-2673 v4 @ 2.30GHz", "intel-xeon-e5-2673-v4"],
    ["Intel® Core™ i7-12700K CPU @ 3.60 GHz", "intel-core-i7-12700k"],
    ["", null],
    ["   CPU @ 2.40GHz  ", null],
    [null, null],
    [undefined, null],
  ];
  for (const [input, expected] of cases) assert.equal(cpuSlug(input), expected);

  const commit = "a".repeat(40);
  const env = { GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule",
    GITHUB_SHA: commit, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" };
  const amd = performanceReport([], "runtime-v1", { commit, commitAt: "2026-11-15T12:00:00Z", cpu: "AMD EPYC 9V74 80-Core Processor" }, env);
  const intel = performanceReport([], "runtime-v1", { commit, commitAt: "2026-11-15T12:00:00Z", cpu: "Intel(R) Xeon(R) 6975P-C" }, env);
  const fallback = performanceReport([], "runtime-v1", { commit, commitAt: "2026-11-15T12:00:00Z", cpu: "" }, env);
  const sizes = performanceReport([], "sizes", { commit, commitAt: "2026-11-15T12:00:00Z" }, env);
  const longCpu = performanceReport([], "runtime-v1", { commit, commitAt: "2026-11-15T12:00:00Z", cpu: `Intel(R) Xeon(R) ${"x".repeat(200)}` }, env);

  assert.equal(amd.runner, "linux-x64.amd-epyc-9v74");
  assert.equal(intel.runner, "linux-x64.intel-xeon-6975p-c");
  assert.equal(fallback.runner, "linux-x64");
  assert.equal(sizes.runner, "linux-x64");
  for (const report of [amd, intel, fallback, sizes, longCpu]) assert.match(report.runner, BENCHMARK_WORD);
});

test("the uploader skips absent credentials, refuses PRs, and surfaces HTTP failures without echoing secrets", async () => {
  const action = await readFile(new URL("../.github/actions/post-performance/action.yml", import.meta.url), "utf8");
  const script = action.split("      run: |\n")[1].split("\n").map((line) => line.slice(8)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "performance-upload-"));
  try {
    await writeFile(join(root, "curl"), '#!/bin/bash\n[[ "${!#}" == https://ops-ingest.mdbase.dev/v1/benchmarks ]] || exit 99\nexit "${FAKE_CURL_STATUS:-0}"\n', { mode: 0o755 });
    const env = { PATH: root, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "push", PERFORMANCE_REPORT: "fixture.json", OPS_BENCHMARK_TOKEN: "" };
    const run = (patch) => spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], { env: { ...env, ...patch }, encoding: "utf8" });
    const skipped = run({});
    assert.equal(skipped.status, 0);
    assert.match(skipped.stdout, /upload skipped/);
    const token = "synthetic-benchmark-credential-never-sent";
    const success = run({ OPS_BENCHMARK_TOKEN: token });
    assert.equal(success.status, 0);
    assert.equal(success.stdout + success.stderr, "");
    const failure = run({ OPS_BENCHMARK_TOKEN: token, FAKE_CURL_STATUS: "22" });
    assert.equal(failure.status, 22);
    assert.ok(!(failure.stdout + failure.stderr).includes(token));
    assert.notEqual(run({ OPS_BENCHMARK_TOKEN: token, GITHUB_EVENT_NAME: "pull_request" }).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
