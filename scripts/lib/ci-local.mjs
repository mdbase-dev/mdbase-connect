/**
 * What `pnpm ci:local` runs, and why the rest of Server CI does not run
 * locally. `ci-local.test.mjs` fails when a workflow step is in neither list,
 * so a new CI gate cannot silently go unchecked before push.
 */

/**
 * Steps `pnpm ci:local` runs, in CI order. `tier` selects them. `fullOnly`
 * marks node-job steps Server CI runs on a pull request only when it selects
 * full qualification; the whole Rust tier is full-only. `remote` is the same
 * gate through rcargo, which needs libtest to run on the VM rather than here.
 */
export const localSteps = [
  { tier: "node", command: "pnpm install --frozen-lockfile" },
  { tier: "node", command: "pnpm check:vendored-sdk" },
  { tier: "node", command: "pnpm version:check" },
  { tier: "node", command: "pnpm check:release-downloads && pnpm test:release-downloads" },
  { tier: "node", command: "pnpm check:release-readiness" },
  { tier: "node", command: "pnpm check:release-components" },
  { tier: "node", command: "pnpm audit:dependencies" },
  { tier: "node", command: "pnpm check:changelog" },
  { tier: "node", command: "pnpm check:generated" },
  { tier: "node", command: "pnpm check:architecture" },
  { tier: "node", command: "pnpm build" },
  { tier: "browser", command: "pnpm test:accessibility", fullOnly: true },
  { tier: "node", command: "pnpm typecheck" },
  { tier: "node", command: "pnpm test" },
  { tier: "node", command: "pnpm package:audit", fullOnly: true }
];

/**
 * The steps for explicitly requested tiers, or, with none requested, the
 * steps Server CI runs on a pull request with the same `native` plan. The
 * browser tier needs Chromium, so it only runs on request.
 */
export function selectSteps(requestedTiers, native) {
  if (requestedTiers.size) return localSteps.filter((step) => requestedTiers.has(step.tier));
  return localSteps.filter((step) => native
    ? step.tier !== "browser"
    : step.tier === "node" && !step.fullOnly);
}

/**
 * Server CI steps that do not run locally, matched by the start of their
 * first command line. Each needs a reason a reviewer can check.
 */
export const ciOnlySteps = [
  { prefix: "pnpm install --frozen-lockfile --filter \"mdbase-editor...\"", reason: "main-push Editor size history job; ci:local's full install covers it" },
  { prefix: "pnpm --filter \"mdbase-editor...\" build", reason: "main-push Editor size history job; ci:local's pnpm build covers the Editor" },
  { prefix: "node scripts/performance-report.mjs", reason: "main-only observations require Actions run provenance; collector regressions run in pnpm test" },
  { prefix: "node scripts/ci/prefetch-worker-tools.mjs", reason: "authenticated binary bootstrap for worker-build; local LAB uses the ops front door" },
  { prefix: "if [[ \"$GITHUB_EVENT_NAME\" == pull_request ]]", reason: "merge-queue qualification reuse" },
  { prefix: "rustup ", reason: "toolchain setup; rust-toolchain.toml selects it locally" },
  { prefix: "node scripts/ci/server-test-plan.mjs", reason: "pull-request path selection and full-suite matrix; ci:local applies serverTestPlan to its own diff" },
  { prefix: "node scripts/ci/runtime-reuse.mjs classify-native", reason: "merge-queue reuse of exact-tree native runtime test results" },
  { prefix: "cargo install worker-build", reason: "pinned Worker build tool for the local DO lane" },
  { prefix: "worker-build --release --locked", reason: "separate wasm32 DO workspace; build with rcargo and package locally before running the harness" },
  { prefix: "cargo build --locked -p mdbn-log-conformance --bin logsvc-bench", reason: "separate runtime workspace; build and pull with rcargo for the DO harness" },
  { prefix: "cargo test --locked -p mdbn-log-conformance --test conformance postgres_backend", reason: "requires disposable Postgres and MDBN_REQUIRE_REAL_BACKENDS=1; run a freshly pulled test binary locally" },
  { prefix: "node tests/runtime.mjs", reason: "requires the built DO Worker and LOGSVC_BENCH; runs isolated local Wrangler with MDBN_REQUIRE_REAL_BACKENDS=1" },
  { prefix: "npm ci", reason: "installs pinned dependencies for the local DO harness" },
  { prefix: "echo 'Playwright cache", reason: "cache marker" },
  { prefix: "pnpm exec playwright install", reason: "browser installation; the browser tier assumes Chromium is installed" },
  { prefix: "mkdir -p \"$RUNNER_TEMP/npm-packages\"", reason: "packs tarballs for publication; package:audit checks them locally" },
  { prefix: "docker build", reason: "container lane; run with pnpm test:system -- --suite container" },
  { prefix: "MDBASE_CONNECT_E2E_BUILD=0 node test/system/run.mjs --suite container", reason: "container lane; run with pnpm test:system -- --suite container" },
  { prefix: "pnpm --filter @mdbase/connect-server exec vitest run src/features/next", reason: "needs the CI PostgreSQL service; locally set MDBASE_CONNECT_TEST_DATABASE_URL and the destructive-test approval, then run the same command" },
  { prefix: "node test/system/run.mjs --suite", reason: "system suites need PostgreSQL and services; run with pnpm test:system" },
  { prefix: "[[ \"$CLASSIFY\" == success ]]", reason: "aggregates the CI lanes into one required check" },
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
