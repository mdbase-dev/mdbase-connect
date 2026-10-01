import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { systemSuites, preparationSteps } from "../../test/system/suites.mjs";

const execute = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

test("every system suite has an existing command and known preparation steps", async () => {
  assert.deepEqual(Object.keys(systemSuites), [
    "local",
    "relay",
    "sync",
    "provider",
    "files",
    "files-adversarial",
    "projection-scale",
    "container",
    "linux-packages",
    "desktop"
  ]);
  for (const [name, suite] of Object.entries(systemSuites)) {
    assert.ok(suite.description, `${name} needs a description`);
    assert.ok(suite.command.length >= 2, `${name} needs a command`);
    await access(resolve(repoRoot, suite.command.at(-1)));
    for (const preparation of suite.prepare) {
      assert.ok(preparationSteps[preparation], `${name} has unknown preparation ${preparation}`);
    }
  }
});

test("full Server CI covers every registered system suite exactly once", async () => {
  const workflow = await readFile(resolve(repoRoot, ".github/workflows/server-ci.yml"), "utf8");
  const matrixSuites = [...workflow.matchAll(/^\s+suites:\s*([a-z,-]+)\s*$/gm)]
    .flatMap((match) => match[1].split(","));
  const containerCommands = [...workflow.matchAll(/--suite\s+container\b/g)];
  assert.equal(containerCommands.length, 1, "container suite must have one full-CI job");
  assert.deepEqual(
    [...matrixSuites, "container"].sort(),
    Object.keys(systemSuites).sort()
  );
});

test("system runner lists suites with direct and package-manager arguments", async () => {
  for (const arguments_ of [["--list"], ["--", "--list"]]) {
    const { stdout } = await execute(
      process.execPath,
      [resolve(repoRoot, "test/system/run.mjs"), ...arguments_]
    );
    for (const name of Object.keys(systemSuites)) {
      assert.match(stdout, new RegExp(`^${name}\\s`, "m"));
    }
  }
});

test("an empty explicit suite selection cannot fall back to all suites", async () => {
  // --list keeps even the old parser's incorrect behavior side-effect free.
  await assert.rejects(execute(
    process.execPath,
    [resolve(repoRoot, "test/system/run.mjs"), "--suite", ",,,", "--list"]
  ), error => error.code === 2 && error.stderr.includes("--suite requires a name"));
});

test("system runner only accepts a separator at the command boundary", async () => {
  await assert.rejects(execute(
    process.execPath,
    [resolve(repoRoot, "test/system/run.mjs"), "--list", "--"]
  ), error => error.code === 2 && error.stderr.includes("Unknown option: --"));
});
