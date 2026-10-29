import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ciOnlySteps, classify, localSteps, selectSteps, workflowRunCommands } from "./ci-local.mjs";

const workflow = await readFile(new URL("../../.github/workflows/server-ci.yml", import.meta.url), "utf8");
const commands = workflowRunCommands(workflow);

test("every Server CI step runs in ci:local or is CI-only with a reason", () => {
  const unclassified = [...new Set(commands)].filter((command) => !classify(command));
  assert.deepEqual(unclassified, [], "classify these steps in scripts/lib/ci-local.mjs");
});

test("ci:local runs only steps Server CI still runs", () => {
  const stale = localSteps.filter((step) => !commands.includes(step.command));
  assert.deepEqual(stale, []);
});

test("every CI-only entry still matches a Server CI step", () => {
  const stale = ciOnlySteps.filter((step) => !commands.some((command) => command.startsWith(step.prefix)));
  assert.deepEqual(stale, []);
  for (const step of ciOnlySteps) assert.ok(step.reason, `${step.prefix} needs a reason`);
});

test("strict root catalogue gate bootstraps the kit CLI in a clean checkout", async () => {
  const { scripts } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(scripts["i18n:check"], /^pnpm --filter @mdbase-dev\/i18n build && /);
  assert.match(scripts.build, /^pnpm i18n:check && /);
  assert.match(scripts.pretypecheck, /^pnpm i18n:check && /);
});

test("fullOnly matches the steps Server CI gates on full qualification", () => {
  const job = (name) => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][\w-]+:\n/)[0];
  assert.match(job("hosted-provider-rust"), /^    if: needs\.classify\.outputs\.run_full == 'true'$/m);
  const node = job("node");
  for (const step of localSteps.filter((candidate) => candidate.tier !== "rust")) {
    const gated = node.includes(`if: needs.classify.outputs.run_full == 'true'\n        run: ${step.command}\n`);
    assert.equal(Boolean(step.fullOnly), gated, step.command);
  }
});

test("the default selection mirrors the pull-request plan; tier flags run whole tiers", () => {
  const commands = (tiers, native) => selectSteps(new Set(tiers), native).map((step) => step.command);
  const fast = commands([], false);
  assert.ok(fast.includes("pnpm test"));
  assert.ok(!fast.includes("pnpm package:audit"));
  assert.ok(!selectSteps(new Set(), false).some((step) => step.tier === "rust"));
  const native = commands([], true);
  assert.ok(native.includes("pnpm package:audit"));
  assert.ok(native.includes("node scripts/ci/cargo-test.mjs --locked --workspace"));
  assert.ok(!native.includes("pnpm test:accessibility"));
  assert.deepEqual(commands(["node", "rust", "browser"], false), localSteps.map((step) => step.command));
});

test("folded and literal run blocks yield their command", () => {
  assert.deepEqual(workflowRunCommands([
    "    defaults:",
    "      run:",
    "        working-directory: app",
    "    steps:",
    "      - run: pnpm test",
    "      - run: >-",
    "          A=1",
    "          node run.mjs",
    "      - name: Script",
    "        run: |",
    "",
    "          first line",
    "          second line"
  ].join("\n")), ["pnpm test", "A=1 node run.mjs", "first line"]);
});
