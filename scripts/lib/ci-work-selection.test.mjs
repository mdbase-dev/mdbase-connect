import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { desktopTestPlan } from "../ci/desktop-test-plan.mjs";
import { serverTestPlan } from "../ci/server-test-plan.mjs";

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
    assert.match(block, /!cancelled\(\) && \(github.event_name == 'workflow_dispatch' \|\|/);
    assert.doesNotMatch(block, /always\(\)/);
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
  for (const command of ["cargo fmt --all --check", "scripts/check-cargo-features", "cargo clippy --locked --workspace --all-targets -- -D warnings", "node scripts/ci/cargo-test.mjs --locked --workspace"]) {
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

test("pull requests changing native or system-suite inputs run full Server CI", () => {
  for (const path of ["crates/connect-core/src/lib.rs", "Cargo.lock", "Cargo.toml", "rust-toolchain.toml",
    "deploy/docker/mdbase-rs-revision", "deploy/docker/Cargo.lock.hosted-provider", "deploy/postgres/schema.sql",
    "test/system/suites.mjs", "test/upgrade/lib.sh", "scripts/diagnostics/windows-428.ps1",
    "scripts/hosted-file-adversarial-e2e.mjs", "scripts/hosted-projection-scale-e2e.mjs",
    ".github/workflows/server-ci.yml", ".github/workflows/windows-daemon-lifecycle.yml"]) {
    assert.deepEqual(serverTestPlan(["docs/readme.md", path]), { native: true }, path);
  }
  for (const paths of [[], ["apps/editor/src/App.tsx"], ["docs/ci-qualification.md"], ["packages/client/src/index.ts"]]) {
    assert.deepEqual(serverTestPlan(paths), { native: false }, paths.join());
  }
  const classify = workflow("server-ci").split("  classify:\n")[1].split("  windows-daemon-lifecycle:\n")[0];
  assert.match(classify, /node scripts\/ci\/server-test-plan\.mjs "\$BASE" "\$HEAD"/);
  assert.match(classify, /if \[\[ \$NATIVE_CHANGES == true \]\] \|\|/);
});

test("Rust caches are restored by CI jobs and written only by rust-caches.yml from main", () => {
  const owner = workflow("rust-caches");
  assert.match(owner, /save-if: \$\{\{ github.ref == 'refs\/heads\/main' \}\}/);
  const warmed = new Set([...owner.matchAll(/^\s+- cache: ([a-z-]+)$/gm)].map((match) => match[1]));
  let consumers = 0;
  for (const name of ["server-ci", "desktop-release", "windows-daemon-lifecycle"]) {
    for (const [, inputs] of workflow(name).matchAll(/uses: Swatinem\/rust-cache@[^\n]*\n((?: {8,}\S.*\n)+)/g)) {
      consumers += 1;
      assert.match(inputs, /save-if: false/, name);
      const key = inputs.match(/shared-key: ([a-z-]+)-\$\{\{/)?.[1];
      assert.ok(warmed.has(key), `${name} restores ${key}, which rust-caches.yml does not write`);
    }
  }
  assert.equal(consumers, 7);
});

test("Windows headless smoke reuses the Store package job's release CLI", () => {
  const desktop = workflow("desktop-release");
  const headless = desktop.split("  headless-package-smoke:\n")[1].split("  cross-platform-release-tests:\n")[0];
  assert.doesNotMatch(headless, /os: windows-2025/);
  const store = desktop.split("  windows-package-smoke:\n")[1];
  assert.match(store, /if: github.event_name == 'workflow_dispatch' \|\| needs.select-tests.outputs.headless == 'true'/);
  assert.match(store, /run: scripts\/ci\/smoke-headless-cli.sh windows x64/);
});
