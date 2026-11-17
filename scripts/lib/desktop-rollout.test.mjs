import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseRollout,
  rolloutBytes,
  rolloutDocument,
  rolloutService,
  rolloutUrl,
  stageMinimumMs,
  stageOf,
  variableSet,
  wideningPlan
} from "./desktop-rollout.mjs";

const workflow = readFileSync(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
const job = name => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
const now = Date.parse("2026-11-17T12:00:00.000Z");
const at = (stage, ageMs) => rolloutDocument("v0.1.3", stage, new Date(now - ageMs));

test("rollout documents name a stage, round-trip exactly and match the client schema", () => {
  const document = rolloutDocument("v0.1.3", "early", new Date(now));
  assert.deepEqual(document, {
    schema: "mdbase-desktop-rollout/1",
    tag: "v0.1.3",
    version: "0.1.3",
    issued_at: "2026-11-17T12:00:00.000Z",
    early_access: true,
    percentage: 0
  });
  assert.deepEqual(parseRollout(rolloutBytes(document), "v0.1.3"), document);
  assert.throws(() => parseRollout(rolloutBytes(document), "v0.1.4"));
  assert.throws(() => parseRollout(JSON.stringify({ ...document, extra: 1 }), "v0.1.3"));
  assert.throws(() => rolloutDocument("v0.1.3", "50"), /Unknown rollout stage/);
  assert.throws(() => rolloutDocument("main", "early"), /Invalid release tag/);
  for (const stage of ["held", "early", "5", "25", "100"]) assert.equal(stageOf(rolloutDocument("v0.1.3", stage)), stage);
  assert.equal(stageOf({ ...document, percentage: 50 }), null);
  // The desktop client parses the same fields.
  const client = readFileSync(new URL("../../apps/desktop/src/main/update-policy.ts", import.meta.url), "utf8");
  assert.match(client, /exactKeys\(root, \["schema", "tag", "version", "issued_at", "early_access", "percentage"\]/);
  assert.match(client, /ROLLOUT_SCHEMA = "mdbase-desktop-rollout\/1"/);
});

test("the coordinator widens one stage at a time, six hours apart, and never out of a hold", () => {
  assert.deepEqual(wideningPlan({ document: null, now }), { operation: "none", reason: "no rollout document" });
  assert.equal(wideningPlan({ document: at("early", stageMinimumMs - 1), now }).operation, "wait");
  assert.deepEqual(wideningPlan({ document: at("early", stageMinimumMs), now }), { operation: "widen", stage: "5" });
  assert.deepEqual(wideningPlan({ document: at("5", stageMinimumMs), now }), { operation: "widen", stage: "25" });
  assert.deepEqual(wideningPlan({ document: at("25", stageMinimumMs), now }), { operation: "widen", stage: "100" });
  assert.equal(wideningPlan({ document: at("100", stageMinimumMs), now }).reason, "complete");
  assert.equal(wideningPlan({ document: at("held", 10 * stageMinimumMs), now }).operation, "none");
  assert.equal(wideningPlan({ document: { ...at("25", stageMinimumMs), percentage: 50 }, now }).operation, "none");
  assert.equal(wideningPlan({ document: at("early", stageMinimumMs), held: true, now }).reason, "DESKTOP_ROLLOUT_HELD is set");
  assert.throws(() => wideningPlan({ document: at("early", -1), now }), /Invalid rollout issue time/);
});

test("the rollout service and hold switch are strict", () => {
  assert.equal(rolloutService(undefined), null);
  assert.equal(rolloutService(""), null);
  assert.equal(rolloutService("https://updates.mdbase.dev"), "https://updates.mdbase.dev");
  assert.throws(() => rolloutService("http://updates.mdbase.dev"), /HTTPS/);
  assert.throws(() => rolloutService("https://updates.mdbase.dev/desktop"), /without a path/);
  assert.equal(rolloutUrl("https://updates.mdbase.dev", "v0.1.3"), "https://updates.mdbase.dev/desktop/v1/rollout/v0.1.3.json");
  assert.throws(() => rolloutUrl("https://updates.mdbase.dev", "../v0.1.3"), /Invalid release tag/);
  assert.equal(variableSet(undefined, "X"), false);
  assert.equal(variableSet("false", "X"), false);
  assert.equal(variableSet("true", "X"), true);
  assert.throws(() => variableSet("yes", "X"), /true, false or unset/);
});

test("a release starts at early access before it is published, only when the service is configured", () => {
  const publish = job("publish");
  const start = publish.indexOf("- name: Start the staged rollout at early access");
  assert(start > publish.indexOf("- name: Create draft prerelease with every asset"));
  assert(start < publish.indexOf("- name: Publish complete prerelease"));
  assert.match(publish.slice(start), /^- name: Start the staged rollout at early access\n\s+if: vars\.DESKTOP_ROLLOUT_SERVICE != ''\n[\s\S]*?run: node scripts\/desktop-rollout\.mjs publish early\n/);
  assert.match(publish, /id-token: write/);
});

test("rollout runs are tag-bound, separate from release builds and cannot change a release", () => {
  const rollout = job("rollout");
  assert.match(rollout, /if: github\.event_name == 'workflow_dispatch' && startsWith\(github\.ref, 'refs\/tags\/v'\) && inputs\.operation == 'rollout'/);
  assert.match(rollout, /permissions:\n      contents: read\n      id-token: write\n/);
  assert.match(rollout, /isDraft --jq \.isDraft\)" = false/);
  assert.match(rollout, /run: node scripts\/desktop-rollout\.mjs publish "\$STAGE"/);
  assert.doesNotMatch(rollout, /needs:|environment:|secrets\.|gh release (?:edit|upload|delete|create)/);
  assert.match(workflow, /group: desktop-release-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| inputs\.operation == 'rollout' && format\('rollout-\{0\}', github\.ref_name\) \|\| 'live' \}\}/);
  assert.match(workflow, /options: \[held, early, '5', '25', '100'\]\n\s+default: held/);
  assert.match(job("coordinate"), /github\.event_name == 'workflow_dispatch' && inputs\.operation == 'release'/);
  assert.doesNotMatch(workflow, /expedite/i, "desktop releases as changes merge; nothing to expedite");
});

test("rollout documents are signed by the release's tag identity and uploaded with the run's OIDC token", () => {
  const source = readFileSync(new URL("../desktop-rollout.mjs", import.meta.url), "utf8");
  assert.match(source, /desktop-release\.yml@refs\/tags\/\$\{tag\}/);
  assert.match(source, /assert\.equal\(env\.GITHUB_REF, `refs\/tags\/\$\{tag\}`/);
  assert.match(source, /"sign-blob", "--yes", "--bundle"/);
  assert.match(source, /url\.searchParams\.set\("audience", rolloutAudience\)/);
  assert.match(source, /assert\.deepEqual\(served, document/);
  assert.doesNotMatch(source, /process\.env\.[A-Z_]*(?:SECRET|API_TOKEN|KEY)\b/);
});
