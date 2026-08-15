#!/usr/bin/env node

import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { generateBenchmarkFixture, ONE_GIB } from "./fixture.mjs";

const options = parse(process.argv.slice(2));
const execFileAsync = promisify(execFile);
const [{ stdout: revision }, { stdout: status }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: resolve(import.meta.dirname, "../..") }),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: resolve(import.meta.dirname, "../..") })
]);
const dirtyPaths = status.trim().split("\n").filter(Boolean).filter((line) =>
  !line.slice(3).startsWith("docs/benchmarks/hosted-storage-model/fixtures/")
);
const manifest = await generateBenchmarkFixture({
  ...options,
  workloadContractPath: resolve(
    import.meta.dirname,
    "../../docs/benchmarks/hosted-storage-model/workload-contract.json"
  ),
  fixtureContractPath: resolve(
    import.meta.dirname,
    "../../docs/benchmarks/hosted-storage-model/fixture-contract.json"
  ),
  sourceRevision: revision.trim(),
  sourceDirty: dirtyPaths.length > 0,
  sourceDirtyPaths: dirtyPaths.map((line) => line.slice(3))
});
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

function parse(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--output") result.output = resolve(arguments_[++index]);
    else if (argument === "--records") result.records = Number(arguments_[++index]);
    else if (argument === "--minimum-canonical-bytes") {
      const value = arguments_[++index];
      result.minimumCanonicalBytes = value === "1GiB" ? ONE_GIB : Number(value);
    } else if (argument === "--seed") result.seed = arguments_[++index];
    else throw new Error(`unknown or incomplete argument: ${argument}`);
  }
  if (!result.output) throw new Error("--output is required");
  return result;
}
