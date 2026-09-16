import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { desktopTestPlan } from "../ci/desktop-test-plan.mjs";

const workflow = (name) => readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");

test("editor styling skips native CLI and Windows packaging, not release regressions", () => {
  assert.deepEqual(desktopTestPlan(["apps/editor/src/styles.css"]), { headless: false, windows: false });
  assert.deepEqual(desktopTestPlan(["apps/editor/src/main.ts"]), { headless: false, windows: true });
  assert.deepEqual(desktopTestPlan(["apps/editor/package.json"]), { headless: false, windows: true });
  assert.match(workflow("desktop-release"), /cross-platform-release-tests:\n    if: github.event_name != 'push'/);
});

test("shared, native, unknown, empty and mixed inputs retain native checks", () => {
  for (const path of ["Cargo.lock", "Cargo.toml", "crates/cli/src/main.rs", "deploy/docker/mdbase-rs-revision", "apps/desktop/src/main.ts", "packages/sdk/src/index.ts", "pnpm-lock.yaml", ".github/workflows/desktop-release.yml", "scripts/package-headless-cli.mjs", "unknown/input"]) {
    for (const paths of [[path], ["apps/editor/src/styles.css", path]]) {
      assert.deepEqual(desktopTestPlan(paths), { headless: true, windows: true });
    }
  }
  assert.deepEqual(desktopTestPlan([]), { headless: true, windows: true });
});

test("native selection retains explicit dispatch checks and includes Rust input triggers", () => {
  const desktop = workflow("desktop-release");
  for (const job of ["headless-package-smoke", "windows-package-smoke"]) {
    const block = desktop.split(`  ${job}:\n`)[1].split(/\n  [a-z][\w-]+:\n/)[0];
    assert.match(block, /needs: select-tests/);
    assert.match(block, /always\(\) && \(github.event_name == 'workflow_dispatch' \|\|/);
    assert.match(block, /needs.select-tests.result == 'success'/);
  }
  for (const path of ["Cargo.toml", "Cargo.lock", "crates/**", "deploy/docker/mdbase-rs-revision", "scripts/ci/desktop-test-plan.mjs"]) {
    assert.ok(desktop.includes(`- "${path}"`));
  }
});

test("same-configuration Rust checks run once and remain required for qualification", () => {
  const server = workflow("server-ci");
  const rust = server.split("  hosted-provider-rust:\n")[1].split("  binary-transfer-benchmark:\n")[0];
  const shards = server.split("  hosted-provider-system:\n")[1].split("  qualification:\n")[0];
  for (const command of ["cargo fmt --all --check", "scripts/check-cargo-features", "cargo clippy --locked --workspace --all-targets -- -D warnings", "cargo test --locked --workspace"]) {
    assert.ok(rust.includes(command), command);
    assert.ok(!shards.includes(command), command);
  }
  for (const block of [rust, shards]) {
    assert.ok(block.includes("cp deploy/docker/Cargo.lock.hosted-provider Cargo.lock"));
    assert.ok(block.includes("cargo build --locked --workspace"));
    assert.ok(block.includes("1.94.0"));
  }
  const gate = server.split("  qualification:\n")[1];
  assert.match(gate, /- hosted-provider-rust/);
  assert.match(gate, /- hosted-provider-system/);
  assert.match(gate, /"\$PROVIDER_RUST"/);
  assert.match(gate, /"\$PROVIDER_SYSTEM"/);
  assert.doesNotMatch(shards, /needs: hosted-provider-rust/);
});

test("binary transfer remains opt-in and outside the qualification gate", () => {
  const server = workflow("server-ci");
  assert.match(server, /\.name == "ci:full" or \.name == "ci:benchmark-binaries"/);
  assert.match(server, /compression-level: 1/);
  const benchmark = server.split("  binary-transfer-benchmark:\n")[1].split("  hosted-provider-system:\n")[0];
  assert.match(benchmark, /needs: hosted-provider-rust/);
  assert.match(benchmark, /github.event_name == 'pull_request' && contains/);
  assert.match(benchmark, /\.\/mdbase --help/);
  assert.doesNotMatch(server.split("  qualification:\n")[1], /binary-transfer-benchmark/);
});
