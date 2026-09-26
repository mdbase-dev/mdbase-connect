#!/usr/bin/env node
// Run Server CI's local gates before pushing. Runs every selected step and
// reports all failures at once, so one run shows everything CI would reject.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { localSteps } from "./lib/ci-local.mjs";

const args = new Set(process.argv.slice(2));
const usage = "usage: pnpm ci:local [--node] [--rust] [--browser]\n" +
  "  Default: node and rust tiers. --browser adds the Chromium suites.";
if (args.has("--help") || [...args].some((arg) => !["--node", "--rust", "--browser"].includes(arg))) {
  console.log(usage);
  process.exit(args.has("--help") ? 0 : 2);
}
const tiers = args.size === 0 ? new Set(["node", "rust"]) : new Set([...args].map((arg) => arg.slice(2)));
const root = resolve(import.meta.dirname, "..");
const failures = [];
for (const step of localSteps.filter((candidate) => tiers.has(candidate.tier))) {
  console.log(`\n==> ${step.command}`);
  const started = Date.now();
  const result = spawnSync("bash", ["-c", step.command], { cwd: root, stdio: "inherit" });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.status !== 0) failures.push(step.command);
  console.log(`    ${result.status === 0 ? "ok" : "FAILED"} in ${seconds}s`);
}
console.log(failures.length
  ? `\n${failures.length} step(s) would fail Server CI:\n${failures.map((command) => `  - ${command}`).join("\n")}`
  : "\nEvery selected Server CI gate passed.");
console.log("Not run locally: container, upgrade and system lanes (see scripts/lib/ci-local.mjs).");
process.exit(failures.length ? 1 : 0);
