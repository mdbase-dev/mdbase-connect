#!/usr/bin/env node
// Run Server CI's local gates before pushing. Runs every selected step and
// reports all failures at once, so one run shows everything CI would reject.
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { serverTestPlan } from "./ci/server-test-plan.mjs";
import { selectSteps } from "./lib/ci-local.mjs";

const args = new Set(process.argv.slice(2));
const usage = "usage: pnpm ci:local [--node] [--rust] [--browser]\n" +
  "  Default: the steps Server CI runs on a pull request with this branch's\n" +
  "  changes since origin/main. Tier flags run those tiers in full instead;\n" +
  "  --browser adds the Chromium suites.";
if (args.has("--help") || [...args].some((arg) => !["--node", "--rust", "--browser"].includes(arg))) {
  console.log(usage);
  process.exit(args.has("--help") ? 0 : 2);
}
const tiers = new Set([...args].map((arg) => arg.slice(2)));
const root = resolve(import.meta.dirname, "..");
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" });
let native = true;
if (!tiers.size) {
  // Committed, staged, unstaged and untracked changes, so the plan covers
  // what the push will contain once committed. --no-renames keeps both sides
  // of moves, as in CI.
  const base = git("merge-base", "origin/main", "HEAD").trim();
  const paths = [
    ...git("diff", "--no-renames", "--name-only", "-z", base).split("\0"),
    ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
  ].filter(Boolean);
  ({ native } = serverTestPlan(paths));
  console.log(native
    ? "Native inputs changed since origin/main: running the full node and Rust gates (add --browser for Chromium)."
    : "No native inputs changed since origin/main: running the pull-request node gates (pass --node --rust for every step).");
}
const failures = [];
for (const step of selectSteps(tiers, native)) {
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
