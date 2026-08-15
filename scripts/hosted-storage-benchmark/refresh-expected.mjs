#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { refreshExpectedResults } from "./fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const [{ stdout: revision }, { stdout: status }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root })
]);
const dirtyPaths = status.split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3))
  .filter((path) => !path.startsWith("docs/benchmarks/hosted-storage-model/fixtures/"));
const tiers = process.argv.slice(2);
if (tiers.length === 0) throw new Error("provide at least one fixture tier");

for (const tier of tiers) {
  const manifest = await refreshExpectedResults({
    fixtureDirectory: resolve(root, "docs/benchmarks/hosted-storage-model/fixtures", tier),
    workloadContractPath: resolve(root, "docs/benchmarks/hosted-storage-model/workload-contract.json"),
    sourceRevision: revision.trim(),
    sourceDirty: dirtyPaths.length > 0,
    sourceDirtyPaths: dirtyPaths
  });
  process.stdout.write(`${tier}: ${manifest.expectedResultsSha256}\n`);
}
