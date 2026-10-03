import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failures } from "./cargo-test.mjs";

test("cargo retry requires named failures and a complete matching summary", () => {
  assert.deepEqual(failures("test a::b ... FAILED\ntest a::c ... FAILED\ntest result: FAILED. 3 passed; 2 failed; 0 ignored;\n"), ["a::b", "a::c"]);
  assert.equal(failures("test a::b ... FAILED\nprocess aborted"), null);
  assert.equal(failures("test a::b ... FAILED\ntest result: FAILED. 3 passed; 2 failed;"), null);
  assert.equal(failures("test result: ok. 1 passed; 0 failed;"), null);
});

test("cargo retries only failed tests once; persistent, crash and build failures stay red", { timeout: 120000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "cargo-retry-"));
  const runner = fileURLToPath(new URL("./cargo-test.mjs", import.meta.url));
  try {
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="retry-fixture"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="lib.rs"\n');
    writeFileSync(join(root, "lib.rs"), `
      #[cfg(test)] mod tests {
        fn count(name: &str) -> usize {
          let path = std::path::PathBuf::from(std::env::var("COUNTERS").unwrap()).join(name);
          let n = std::fs::read_to_string(&path).unwrap_or_default().parse::<usize>().unwrap_or(0) + 1;
          std::fs::write(path, n.to_string()).unwrap(); n
        }
        #[test] fn flaky() { let n = count("flaky"); assert!(n > 1); }
        #[test] fn stable() { count("stable"); }
        #[test] #[ignore] fn ignored_only() { panic!("requires an external fixture"); }
        #[test] fn persistent() { if std::env::var("FIXTURE_MODE").unwrap() == "persistent" { count("persistent"); panic!("persistent failure"); } }
        #[test] fn crash() { if std::env::var("FIXTURE_MODE").unwrap() == "crash" { count("crash"); std::process::abort(); } }
      }
    `);
    let mode = "normal", selection = ["--lib"];
    const invoke = (...args) => spawnSync(process.execPath, [runner, ...args, ...selection], {
      cwd: root, encoding: "utf8", timeout: 60000,
      env: { ...process.env, CI: "1", GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", CARGO_BUILD_JOBS: "2", FIXTURE_MODE: mode, COUNTERS: root, CI_FLAKE_DIR: join(root, "reports"), CARGO_TARGET_DIR: join(root, "target") }
    });
    const result = invoke();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(root, "flaky"), "utf8"), "2");
    const rows = readdirSync(join(root, "reports")).filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => readFileSync(join(root, "reports", file), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(rows[0].test, "tests::flaky");
    assert.equal(rows[0].recovered, true);
    assert.equal(readFileSync(join(root, "stable"), "utf8"), "1");
    mode = "persistent";
    assert.equal(invoke("--filter", "persistent").status, 1);
    assert.equal(readFileSync(join(root, "persistent"), "utf8"), "2");
    mode = "crash";
    assert.equal(invoke("--filter", "crash").status, 1);
    assert.equal(readFileSync(join(root, "crash"), "utf8"), "1");
    assert.equal(invoke("--filter", "stable").status, 0);
    assert.equal(readFileSync(join(root, "stable"), "utf8"), "2");
    mode = "normal";
    rmSync(join(root, "flaky"));
    assert.equal(invoke("--stress", "2", "--match", "tests::flaky").status, 1);
    assert.equal(readFileSync(join(root, "flaky"), "utf8"), "2");
    assert.equal(invoke("--stress", "1", "--match", "does_not_exist").status, 1);
    assert.equal(invoke("--stress", "1", "--match", "ignored_only").status, 1);
    writeFileSync(join(root, "lib.rs"), "invalid rust");
    assert.equal(invoke().status, 1);
    selection = [];
    writeFileSync(join(root, "lib.rs"), '/// ```\n/// assert!(false);\n/// ```\npub fn doctest() {}\n');
    assert.equal(invoke().status, 1, "doctest failures must remain failures");
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="retry-fixture"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="retry-fixture"\npath="main.rs"\n');
    writeFileSync(join(root, "main.rs"), 'fn main() {}\n#[test] fn passes() {}\n');
    assert.equal(invoke().status, 0, "binary-only packages have no doctest gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
