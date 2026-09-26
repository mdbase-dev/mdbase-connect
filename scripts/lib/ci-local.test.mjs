import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ciOnlySteps, classify, localSteps, workflowRunCommands } from "./ci-local.mjs";

const commands = workflowRunCommands(
  await readFile(new URL("../../.github/workflows/server-ci.yml", import.meta.url), "utf8")
);

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
