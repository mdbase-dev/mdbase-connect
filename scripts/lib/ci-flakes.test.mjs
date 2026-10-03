import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { failures } from "../ci/cargo-test.mjs";
import "../ci/track-flakes.test.mjs";

test("cargo retry requires named failures and a complete matching summary", () => {
  assert.deepEqual(failures("test a::b ... FAILED\ntest a::c ... FAILED\ntest result: FAILED. 3 passed; 2 failed; 0 ignored;\n"), ["a::b", "a::c"]);
  assert.equal(failures("test a::b ... FAILED\nprocess aborted"), null);
  assert.equal(failures("test a::b ... FAILED\ntest result: FAILED. 3 passed; 2 failed;"), null);
  assert.equal(failures("test result: ok. 1 passed; 0 failed;"), null);
});

test("Vitest records recovered attempts and persistent failures, not first-pass successes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-flake-reporter-"));
  try {
    // Load in a fresh process: cargo-test already imported the report module.
    const { spawnSync } = await import("node:child_process");
    const source = `
      import Reporter from './scripts/ci/vitest-reporter.mjs';
      const reporter = new Reporter();
      for (const [retryCount, state] of [[0, 'passed'], [1, 'passed'], [1, 'failed'], [0, 'failed']]) {
        reporter.onTestCaseResult({ diagnostic: () => ({ retryCount }), result: () => ({ state }),
          module: { moduleId: 'suite.ts' }, fullName: 'exact test name' });
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: { ...process.env, CI_FLAKE_DIR: directory, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" } });
    assert.equal(result.status, 0, result.stderr);
    const rows = readdirSync(directory).flatMap((file) => readFileSync(join(directory, file), "utf8").trim().split("\n").map(JSON.parse));
    assert.deepEqual(rows.map((row) => row.recovered), [true, false, false]);
    assert.ok(rows.every((row) => row.test === "exact test name"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real Vitest retries once with hooks, records recovered and persistent failures", { timeout: 30000 }, async () => {
  const { spawnSync } = await import("node:child_process");
  const cwd = resolve("packages/client");
  const directory = mkdtempSync(join(cwd, "ci-flake-fixture-"));
  const reports = join(directory, "reports");
  try {
    writeFileSync(join(directory, "vitest.config.mjs"), `export default { test: { include: [${JSON.stringify(join(directory, "fixture.test.ts"))}] } };`);
    writeFileSync(join(directory, "fixture.test.ts"), `
      import { beforeEach, expect, it } from 'vitest';
      let attempts = 0, hooks = 0;
      beforeEach(() => { hooks++; });
      it('fails once', () => { attempts++; expect(attempts).toBe(2); expect(hooks).toBe(2); });
      it('first pass', () => { expect(true).toBe(true); });
      it.skip('skip diagnostics', () => {});
    `);
    const invoke = () => spawnSync(process.execPath, [resolve("scripts/ci/vitest.mjs"), "--config", join(directory, "vitest.config.mjs")], {
      cwd, encoding: "utf8", timeout: 20000, env: { ...process.env, CI: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", CI_FLAKE_DIR: reports }
    });
    const result = invoke();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = () => readdirSync(reports).filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readFileSync(join(reports, file), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].test, "fails once");
    assert.equal(rows()[0].retries, 1);
    assert.equal(rows()[0].recovered, true);
    writeFileSync(join(directory, "fixture.test.ts"), `import { expect, it } from 'vitest'; it('persistent failure', () => expect(true).toBe(false));`);
    assert.equal(invoke().status, 1);
    assert.equal(rows().find((row) => row.test === "persistent failure").recovered, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
