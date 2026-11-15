import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { loadBundleAssets } from "../apps/editor/scripts/bundle-assets.mjs";

export function performanceSuite({ app, wasm, sdkPackage, runtime }) {
  const selected = [[app, "sizes"], [wasm?.length, "sizes.wasm"], [sdkPackage, "sizes.sdk"], [runtime, "runtime-v1"]]
    .filter(([input]) => input);
  if (selected.length !== 1) throw new Error("Select exactly one performance build or runtime report");
  return selected[0][1];
}

export async function sizeMetrics({ app = null, wasm = [], sdkPackage = null }) {
  const metrics = [];
  if (app) {
    const source = await readFile(resolve(app, "dist/index.html"), "utf8");
    for (const [name, pattern] of [
      ["editor.initial-js.gzip", /<(?:script|link)\b[^>]+(?:src|href)="([^"]+\.m?js)"/g],
      ["editor.initial-css.gzip", /<link\b[^>]+href="([^"]+\.css)"/g],
    ]) {
      const assets = await loadBundleAssets(resolve(app), [...source.matchAll(pattern)].map((match) => match[1]));
      if (!assets.length) throw new Error(`Missing built assets for ${name}`);
      metrics.push({ name, unit: "bytes", value: assets.reduce((sum, asset) => sum + gzipSync(asset.content, { level: 9 }).length, 0) });
    }
  }
  for (const { name, path } of wasm) {
    if (!["runtime", "app-runtime"].includes(name)) throw new Error("Unknown WASM artifact");
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error("Not a WASM module");
    metrics.push({ name: `${name}.raw`, unit: "bytes", value: bytes.length },
      { name: `${name}.gzip`, unit: "bytes", value: gzipSync(bytes, { level: 9 }).length });
  }
  if (sdkPackage) {
    const bytes = await readFile(sdkPackage);
    if (bytes[0] !== 31 || bytes[1] !== 139 || !(await stat(sdkPackage)).isFile()) throw new Error("Not an npm package archive");
    metrics.push({ name: "sdk.package", unit: "bytes", value: bytes.length });
  }
  if (!metrics.length) throw new Error("No performance inputs selected");
  return metrics;
}

export function runtimeMetrics(report) {
  const calibration = report?.meta?.calibration_ms;
  if (report?.meta?.debug_build !== false || typeof calibration !== "number" || !Number.isFinite(calibration) || calibration <= 0
    || !Array.isArray(report.results) || !report.results.length) throw new Error("Invalid release runtime report");
  const metrics = [];
  const seen = new Set();
  for (const result of report.results) {
    const name = `${result.scenario}.${result.size}`;
    if (!/^[a-z][a-z0-9_.]+$/.test(result.scenario) || !Number.isSafeInteger(result.size) || result.size < 1
      || !Number.isSafeInteger(result.n) || result.n < 0 || seen.has(name)) throw new Error("Invalid runtime scenario");
    seen.add(name);
    if (result.n === 0 && result.min_ms === null && result.p50_ms === null) continue;
    if (result.n === 0) throw new Error("Untimed runtime scenarios cannot report timings");
    for (const [label, key] of [["min", "min_ms"], ["median", "p50_ms"]]) {
      if (typeof result[key] !== "number" || !Number.isFinite(result[key]) || result[key] < 0) throw new Error("Invalid runtime timing");
      metrics.push({ name: `${name}.${label}`, unit: "ratio", value: result[key] / calibration, samples: result.n });
    }
  }
  if (!metrics.length || metrics.length > 80) throw new Error("Runtime report requires 1 to 80 measured metrics");
  return metrics;
}

export function performanceReport(metrics, suite, { commit, commitAt }, env = process.env) {
  if (env.GITHUB_REPOSITORY !== "mdbase-dev/mdbase-connect" || env.GITHUB_REF !== "refs/heads/main"
    || !["push", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) || env.GITHUB_SHA !== commit
    || !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) || Number(env.GITHUB_RUN_ID) < 1
    || !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) || Number(env.GITHUB_RUN_ATTEMPT) < 1
    || !/^[0-9a-f]{40}$/.test(commit) || !Number.isFinite(Date.parse(commitAt))
    || env.RUNNER_OS !== "Linux" || !["X64", "ARM64"].includes(env.RUNNER_ARCH)) throw new Error("Performance reports require an exact main-branch Actions checkout");
  return { schema_version: 1, repo: "connect", suite, run_id: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    commit, commit_at: new Date(commitAt).toISOString(),
    observed_at: new Date().toISOString(), runner: `linux-${env.RUNNER_ARCH.toLowerCase()}`, conclusion: "success", metrics };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({ options: { app: { type: "string" }, wasm: { type: "string", multiple: true },
    "sdk-package": { type: "string" }, runtime: { type: "string" }, out: { type: "string" } } });
  if (!values.out) throw new Error("--out is required");
  const suite = performanceSuite({ ...values, sdkPackage: values["sdk-package"] });
  const metrics = values.runtime ? runtimeMetrics(JSON.parse(await readFile(values.runtime, "utf8")))
    : await sizeMetrics({ app: values.app, sdkPackage: values["sdk-package"], wasm: (values.wasm ?? []).map((value) => {
      const separator = value.indexOf("=");
      if (separator < 1) throw new Error("--wasm requires name=path");
      return { name: value.slice(0, separator), path: value.slice(separator + 1) };
    }) });
  const source = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    commitAt: execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { encoding: "utf8" }).trim() };
  await writeFile(values.out, `${JSON.stringify(performanceReport(metrics, suite, source))}\n`);
}
