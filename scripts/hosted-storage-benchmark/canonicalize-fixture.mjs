#!/usr/bin/env node

import { execFile } from "node:child_process";
import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixtureDir = parse(process.argv.slice(2));
const connectRoot = resolve(import.meta.dirname, "../..");
const mdbaseRoot = resolve(connectRoot, "../mdbase-rs");
const [{ stdout: revision }, { stdout: status }] = await Promise.all([
  execFileAsync("git", ["rev-parse", "HEAD"], { cwd: mdbaseRoot }),
  execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: mdbaseRoot })
]);
const temporary = resolve(fixtureDir, "expected-results.canonical.json");
const arguments_ = [
  "run", "--locked", "-q", "-p", "connect-hosted-storage-benchmark", "--",
  "oracle",
  "--fixture-dir", fixtureDir,
  "--workload-contract", resolve(connectRoot, "docs/benchmarks/hosted-storage-model/workload-contract.json"),
  "--output", temporary,
  "--mdbase-revision", revision.trim()
];
if (status.trim()) arguments_.push("--mdbase-dirty");
await execFileAsync("cargo", arguments_, { cwd: connectRoot, maxBuffer: 16 * 1024 * 1024 });
await rename(temporary, resolve(fixtureDir, "expected-results.json"));

function parse(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== "--fixture-dir") {
    throw new Error("usage: canonicalize-fixture.mjs --fixture-dir <path>");
  }
  return resolve(arguments_[1]);
}
