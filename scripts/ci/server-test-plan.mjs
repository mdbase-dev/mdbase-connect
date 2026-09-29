import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { systemSuites } from "../../test/system/suites.mjs";

// Pull requests opt into full qualification when they change native Rust,
// engine, or system-suite inputs, so merge-queue-only failures surface before
// queueing. This only adds PR coverage: merge-queue commits always run full
// qualification, so an input missing here delays feedback but never skips a
// release gate.
const nativePrefixes = [
  "crates/",
  ".cargo/",
  "rust-toolchain",
  "deploy/docker/",
  "deploy/postgres/",
  "test/system/",
  "test/upgrade/",
  "scripts/diagnostics/"
];
const nativeFiles = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "scripts/check-cargo-features",
  ".github/previous-release.env",
  ".github/retained-v2-predecessor.env",
  ".github/workflows/server-ci.yml",
  ".github/workflows/windows-daemon-lifecycle.yml",
  ...Object.values(systemSuites).map((suite) => suite.command.at(-1))
]);

export function serverTestPlan(paths) {
  return {
    native: paths.some((path) => nativeFiles.has(path)
      || nativePrefixes.some((prefix) => path.startsWith(prefix)))
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Expected base and head revisions");
  // --no-renames includes both sides of moves so native inputs cannot disappear.
  const paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`], {
    encoding: "utf8"
  }).split("\0").filter(Boolean);
  const plan = serverTestPlan(paths);
  console.log(JSON.stringify({ paths, ...plan }, null, 2));
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(plan)
    .map(([key, value]) => `${key}=${value}\n`).join(""));
}
