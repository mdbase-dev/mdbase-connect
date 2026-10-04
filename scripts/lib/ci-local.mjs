/**
 * What `pnpm ci:local` runs, and why the rest of Server CI does not run
 * locally. `ci-local.test.mjs` fails when a workflow step is in neither list,
 * so a new CI gate cannot silently go unchecked before push.
 */

/** Steps `pnpm ci:local` runs, in CI order. `tier` selects them. */
export const localSteps = [
  { tier: "node", command: "pnpm install --frozen-lockfile" },
  { tier: "node", command: "pnpm version:check" },
  { tier: "node", command: "pnpm check:release-readiness" },
  { tier: "node", command: "pnpm check:release-components" },
  { tier: "node", command: "pnpm audit:dependencies" },
  { tier: "node", command: "pnpm check:changelog" },
  { tier: "node", command: "pnpm check:generated" },
  { tier: "node", command: "pnpm check:architecture" },
  { tier: "node", command: "pnpm build" },
  { tier: "browser", command: "pnpm test:browser-storage" },
  { tier: "browser", command: "pnpm test:accessibility" },
  { tier: "node", command: "pnpm typecheck" },
  { tier: "node", command: "pnpm test" },
  { tier: "node", command: "pnpm package:audit" },
  { tier: "rust", command: "cargo fmt --all --check" },
  { tier: "rust", command: "scripts/check-cargo-features" },
  { tier: "rust", command: "cargo clippy --locked --workspace --all-targets -- -D warnings" },
  { tier: "rust", command: "node --test scripts/ci/*.test.mjs" },
  { tier: "rust", command: "node scripts/ci/cargo-test.mjs --locked --workspace" }
];

/**
 * Server CI steps that do not run locally, matched by the start of their
 * first command line. Each needs a reason a reviewer can check.
 */
export const ciOnlySteps = [
  { prefix: "if [[ \"$GITHUB_EVENT_NAME\" == pull_request ]]", reason: "merge-queue qualification reuse" },
  { prefix: "echo \"revision=$(tr -d", reason: "exports the mdbase-rs pin for checkout; local builds use the sibling ../mdbase-rs" },
  { prefix: "pnpm check:mdbase-rs-pin", reason: "merge queue only; a PR may pin an engine commit that is not on mdbase-rs main yet" },
  { prefix: "rustup ", reason: "toolchain setup; rust-toolchain.toml selects it locally" },
  { prefix: "node scripts/ci/server-test-plan.mjs", reason: "pull-request path selection; ci:local runs the Rust tier on request" },
  { prefix: "node scripts/ci/cargo-test.mjs --locked ${{ matrix.packages }}", reason: "macOS and Windows filesystem lanes; covered on Linux by cargo test --workspace" },
  { prefix: "npm ci", reason: "installs the portable testbed runner from the pinned mdbase-spec checkout" },
  { prefix: "cargo build --locked -p mdbase-connect-testbed-adapter", reason: "prebuilds the testbed executable outside its response deadline; local workspace tests compile its harness" },
  { prefix: "node ../mdbase-spec/packages/testbed/src/cli.mjs", reason: "needs the pinned mdbase-spec checkout" },
  { prefix: "echo 'Playwright cache", reason: "cache marker" },
  { prefix: "pnpm exec playwright install", reason: "browser installation; the browser tier assumes Chromium is installed" },
  { prefix: "mkdir -p \"$RUNNER_TEMP/npm-packages\"", reason: "packs tarballs for publication; package:audit checks them locally" },
  { prefix: "docker build", reason: "container lane; run with pnpm test:system -- --suite container" },
  { prefix: "MDBASE_CONNECT_E2E_BUILD=0 node test/system/run.mjs --suite container", reason: "container lane; run with pnpm test:system -- --suite container" },
  { prefix: "test/upgrade/", reason: "published predecessor images and PostgreSQL" },
  { prefix: "pnpm --filter @mdbase/connect-server exec vitest run src/features/next", reason: "needs the CI PostgreSQL service; locally set MDBASE_CONNECT_TEST_DATABASE_URL and the destructive-test approval, then run the same command" },
  { prefix: "env -u DATABASE_URL -u UPGRADE_SERVER_URL test/upgrade/", reason: "published predecessor images and PostgreSQL" },
  { prefix: "source .github/", reason: "pulls and verifies immutable predecessor images" },
  { prefix: "pnpm --filter @mdbase-dev/connect-protocol build", reason: "subset of pnpm build" },
  { prefix: "cp deploy/docker/Cargo.lock.hosted-provider Cargo.lock", reason: "release lock pins the engine by git revision; local builds use the sibling path and the development lock" },
  { prefix: "cargo build --locked --workspace", reason: "implied by cargo test --workspace" },
  { prefix: "tar -", reason: "binary transfer between CI jobs" },
  { prefix: "node test/system/run.mjs --suite", reason: "system suites need PostgreSQL and services; run with pnpm test:system" },
  { prefix: "if [[ \"$RUN_FULL\" == true ]]", reason: "aggregates the CI lanes into one required check" },
  { prefix: "kind=fast", reason: "records qualification inputs" }
];

/**
 * The first command of every `run:` step in a workflow's text. A folded
 * (`>`) block is one command; a literal (`|`) block starts with its first line.
 */
export function workflowRunCommands(workflow) {
  const lines = workflow.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[index]);
    // A bare `run:` is a job's `defaults.run` mapping, not a step.
    if (!match || !match[2].trim()) continue;
    const value = match[2].trim();
    if (!/^[|>][-+]?$/.test(value)) {
      commands.push(value);
      continue;
    }
    const block = [];
    while (index + 1 < lines.length && (!lines[index + 1].trim() || indent(lines[index + 1]) > match[1].length)) {
      block.push(lines[++index].trim());
    }
    const body = block.filter(Boolean);
    commands.push(value.startsWith(">") ? body.join(" ") : body[0] ?? "");
  }
  return commands;
}

const indent = (line) => line.length - line.trimStart().length;

/** How one workflow command is handled locally, or undefined when it is unclassified. */
export function classify(command) {
  const local = localSteps.find((step) => step.command === command);
  if (local) return { local: true, tier: local.tier };
  const ciOnly = ciOnlySteps.find((step) => command.startsWith(step.prefix));
  return ciOnly ? { local: false, reason: ciOnly.reason } : undefined;
}
