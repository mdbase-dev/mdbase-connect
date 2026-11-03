import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { desktopChanged, desktopPlan, requireMutableChannel, rolloutPercentage } from "../continuous-desktop-release.mjs";

const day = 86_400_000;
const now = Date.parse("2026-11-03T12:00:00Z");
const latest = { tag_name: "v0.1.0-beta.153", published_at: new Date(now - 3 * day).toISOString(), body: "" };
const reservation = { tag: latest.tag_name, published: true };
const plan = (percentage, overrides = {}) => desktopPlan({ latest, reservations: [reservation],
  channel: { tag: latest.tag_name, rollout: { percentage, seed: latest.tag_name } }, changed: true, now, ...overrides });

test("rollout advances one stage per run and retains the installation cohort seed", () => {
  assert.deepEqual(plan(10), { operation: "widen", tag: latest.tag_name, percentage: 50 });
  assert.deepEqual(plan(50), { operation: "widen", tag: latest.tag_name, percentage: 100 });
  assert.deepEqual(plan(100), { operation: "release" });
  assert.equal(rolloutPercentage(10, new Date(now - day + 1).toISOString(), now), 10);
  assert.equal(rolloutPercentage(50, new Date(now - 2 * day + 1).toISOString(), now), 50);
  for (const percentage of [-1, 0, 25, 101, "10"]) assert.throws(() => rolloutPercentage(percentage, latest.published_at, now));
  assert.throws(() => rolloutPercentage(10, "bad-date", now));
  assert.throws(() => rolloutPercentage(10, new Date(now + 1).toISOString(), now));
});

test("daily, diff and in-flight rollout gates cannot be bypassed by repeated triggers", () => {
  assert.equal(plan(100, { changed: false }).reason, "desktop tree unchanged");
  const recent = { ...latest, published_at: new Date(now - day + 1).toISOString() };
  assert.equal(plan(100, { latest: recent }).reason, "daily limit");
  assert.equal(plan(10, { latest: recent }).reason, "observing current rollout");
  assert.throws(() => plan(100, { reservations: [{ ...reservation, published: false }] }), /unfinished/);
  assert.throws(() => plan(100, { latest: { ...latest, body: "Continuous desktop status: stopped" } }), /latched stopped/);
});

test("immutable or unknown release settings block publication before allocating a version", () => {
  requireMutableChannel({ enabled: false });
  for (const settings of [undefined, {}, { enabled: true }, { enabled: "false" }]) {
    assert.throws(() => requireMutableChannel(settings), /Immutable releases/);
  }
  const source = readFileSync(new URL("../continuous-desktop-release.mjs", import.meta.url), "utf8");
  assert(source.indexOf('requireMutableChannel(api("immutable-releases"))') < source.indexOf('writeApi("git/tags"'));
});

test("desktop changes include bundled clients and native inputs, not unrelated server or documentation edits", () => {
  for (const path of ["apps/desktop/src/main/main.ts", "apps/editor/src/main.ts", "packages/client/src/index.ts",
    "runtime/crates/daemon/src/main.rs", "runtime/Cargo.lock", "pnpm-lock.yaml", "deploy/docker/mdbase-rs-revision"]) {
    assert.equal(desktopChanged([path]), true, path);
  }
  for (const path of ["services/server/src/main.ts", "docs/releasing.md", "apps/desktop/README.md",
    "apps/desktop/test/update-policy.test.mjs", ".github/workflows/desktop-release.yml"]) assert.equal(desktopChanged([path]), false, path);
});

test("server-only version prep does not create a desktop release", () => {
  assert.equal(desktopChanged(["package.json", "apps/desktop/package.json", "runtime/packages/sdk/package-lock.json"], () => ({
    before: '{"version":"0.1.0-beta.151","packages":{"":{"version":"0.1.0-beta.151"}}}',
    after: '{"version":"0.1.0-beta.152","packages":{"":{"version":"0.1.0-beta.152"}}}'
  })), false);
  assert.equal(desktopChanged(["apps/desktop/package.json"], () => ({ before: '{"dependencies":{"a":"1"}}', after: '{"dependencies":{"a":"2"}}' })), true);
  assert.equal(desktopChanged(["Cargo.toml", "Cargo.lock", "runtime/packages/obsidian-runtime/package.json"]), false);
});

test("automatic desktop jobs preserve tag-bound signing, full CI, e2e and notarization", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:[\s\S]*workflows: \[Server CI\]/);
  assert.match(workflow, /group: desktop-release-.*'live'/);
  assert.match(workflow, /rollout=10/);
  assert.doesNotMatch(workflow, /production_verified_commit|UPDATE_ROLLOUT_PERCENTAGE/);
  for (const gate of ["verify-qualified-commit", "scripts/continuous-desktop-release.mjs compatible", "pnpm test:accessibility",
    "pnpm --filter @mdbase/connect-desktop test", "cosign sign-blob", "cosign verify-blob", "xcrun stapler validate"]) assert(workflow.includes(gate), gate);
  assert.match(workflow, /widen:[\s\S]*environment: desktop-release/);
  assert.match(workflow, /needs: \[build, headless-package-smoke, cross-platform-release-tests, windows-package-smoke\]/);
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && startsWith\(github.ref, 'refs\/tags\/v'\) && inputs.operation == 'release'/);
});
