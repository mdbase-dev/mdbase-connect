import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopChanged, desktopPlan } from "../continuous-desktop-release.mjs";

const day = 86_400_000;
const now = Date.parse("2026-11-03T12:00:00Z");
const latest = { tag_name: "v0.1.0-beta.153", published_at: new Date(now - 3 * day).toISOString(), body: "" };
const reservation = { tag: latest.tag_name, published: true };
const plan = (overrides = {}) => desktopPlan({ latest, reservations: [reservation], changed: true, now, ...overrides });
const workflow = readFileSync(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");

test("changed desktops release at once, including the first and immutable predecessors", () => {
  assert.deepEqual(plan(), { operation: "release" });
  assert.deepEqual(plan({ latest: undefined, reservations: [] }), { operation: "release" });
  assert.deepEqual(plan({ latest: { ...latest, immutable: true } }), { operation: "release" });
  assert.deepEqual(plan({ latest: { ...latest, published_at: new Date(now - day).toISOString() } }), { operation: "release" });
});

test("the qualification gate runs through bash so Windows can spawn it", () => {
  const source = readFileSync(new URL("./continuous-client-release.mjs", import.meta.url), "utf8");
  assert.match(source, /execFileSync\("bash", \["scripts\/ci\/verify-qualified-commit"/);
});

test("daily, diff and unfinished-attempt gates cannot be bypassed by repeated triggers", () => {
  assert.equal(plan({ changed: false }).reason, "desktop tree unchanged");
  const recent = { ...latest, published_at: new Date(now - day + 1).toISOString() };
  assert.equal(plan({ latest: recent }).reason, "daily limit");
  assert.throws(() => plan({ reservations: [{ ...reservation, published: false }] }), /unfinished/);
  assert.throws(() => plan({ changed: false, reservations: [{ ...reservation, published: false }] }), /unfinished/);
  const failed = { tag: "v0.1.0-beta.154", published: false };
  assert.deepEqual(plan({ reservations: [failed], acknowledged: failed.tag }), { operation: "release" });
  assert.throws(() => plan({ reservations: [failed], acknowledged: "v0.1.0-beta.153" }), /unfinished/);
  assert.throws(() => plan({ reservations: [failed, { tag: "v0.1.0-beta.155", published: false }], acknowledged: failed.tag }), /unfinished/);
  assert.throws(() => plan({ reservations: [failed], acknowledged: "154" }), /Invalid desktop release tag/);
  assert.throws(() => plan({ latest: { ...latest, body: "Continuous desktop status: stopped" } }), /latched stopped/);
  for (const published_at of ["bad-date", new Date(now + 1).toISOString()]) {
    assert.throws(() => plan({ latest: { ...latest, published_at } }), /Invalid desktop publication time/);
  }
});

test("immutable release settings are neither queried nor changed and widening is removed", () => {
  const source = readFileSync(new URL("../continuous-desktop-release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /immutable-releases|requireMutableChannel|rolloutPercentage|\bwiden\b|--clobber/);
  assert.doesNotMatch(source, /gh\("release", "(?:upload|edit|delete)"/);
  assert.match(source, /if \(latest\) readChannel\(latest, directory\)/);
  assert.match(source, /cosign.*\["verify-blob"/);
  assert.match(workflow, /options: \[release\]/);
  assert.doesNotMatch(workflow, /\bwiden\b|--clobber|gh release (?:upload|delete)/);
});

function stepCommand(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert(start >= 0, name);
  const step = workflow.slice(start).split(/\n      - /)[0];
  const command = /        run: (.+)(?:\n([\s\S]*))?/.exec(step);
  assert(command, name);
  return command[1] === "|" ? command[2].replace(/^          /gm, "") : command[1];
}

test("every asset uploads to a draft before the final guard and one-way publication", () => {
  const create = stepCommand("Create draft prerelease with every asset");
  const guard = stepCommand("Recheck production compatibility and stop switch immediately before publication");
  const publish = stepCommand("Publish complete prerelease");
  assert.match(create, /gh release create[^]*release-artifacts\/\*[^]*--draft\s/);
  assert.match(publish, /gh release edit[^]*--draft=false$/);
  assert(workflow.indexOf(create) < workflow.indexOf(guard));
  assert(workflow.indexOf(guard) < workflow.indexOf(publish));
  const directory = mkdtempSync(join(tmpdir(), "desktop-publication-test-"));
  try {
    mkdirSync(join(directory, "release-artifacts"));
    const assets = ["desktop.dmg", "desktop.dmg.sigstore.json", "SHA256SUMS-macos", "SHA256SUMS-update",
      "mdbase-connect-channel-v1.json", "mdbase-connect-channel-v1.json.sigstore.json",
      "mdbase-connect-update.json", "mdbase-connect-update.json.sigstore.json"];
    for (const asset of assets) writeFileSync(join(directory, "release-artifacts", asset), "fixture");
    const commands = `
gh() {
  printf '%s\\n' "$*"
  if [[ "$1 $2" == "release create" ]]; then return "$UPLOAD_STATUS"; fi
  return "$PUBLISH_STATUS"
}
node() {
  printf '%s\\n' "$*"
  return "$GUARD_STATUS"
}
${create}
${guard}
${publish}
`;
    for (const [upload, compatible, publication] of [[0, 0, 0], [23, 0, 0], [0, 24, 0], [0, 0, 25]]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", commands], {
        cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_REF_NAME: latest.tag_name,
          GITHUB_REPOSITORY: "mdbase-dev/mdbase-connect", UPLOAD_STATUS: String(upload),
          GUARD_STATUS: String(compatible), PUBLISH_STATUS: String(publication) }
      });
      assert.equal(result.status, upload || compatible || publication, result.stderr);
      const calls = result.stdout.trim().split("\n");
      for (const asset of assets) assert(calls[0].includes(`release-artifacts/${asset}`), asset);
      assert(calls[0].includes("--draft"));
      assert.equal(calls.length, upload ? 1 : compatible ? 2 : 3);
      if (!upload && !compatible) {
        assert.equal(calls[1], "scripts/continuous-desktop-release.mjs compatible");
        assert.equal(calls[2], `release edit ${latest.tag_name} --repo mdbase-dev/mdbase-connect --draft=false`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("publication reaches a skipped test selector only through explicit job results", () => {
  const job = name => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
  const publish = job("publish");
  assert.match(publish, /if: >-\s+\$\{\{ !cancelled\(\)/);
  for (const need of ["build", "headless-package-smoke", "cross-platform-release-tests", "windows-package-smoke"]) {
    assert.match(publish, new RegExp(`needs\\.${need}\\.result == 'success'`));
  }
  assert.match(job("website-update"), /if: \$\{\{ !cancelled\(\) && .*needs\.publish\.result == 'success' \}\}/);
});

test("coordinator pins production-contained source without changing the tag worker or compatibility recheck", () => {
  const source = readFileSync(new URL("../continuous-desktop-release.mjs", import.meta.url), "utf8");
  assert.match(source, /const commit = await checkoutProductionCommit\(env\)/);
  assert.match(source, /env = \{ \.\.\.env, GITHUB_SHA: commit \}/);
  assert.doesNotMatch(source, /Main advanced|next green run owns|rev-parse", "origin\/main"/);
  assert.match(source, /await verifyCompatibility\(env\)/);
  assert.match(source, /tag, object: env.GITHUB_SHA, type: "commit"/);
  assert.match(source, /commit: env.GITHUB_SHA/);
  assert.match(source, /gh\("workflow", "run", "desktop-release.yml", "--repo", repository, "--ref", tag/);
  assert.match(source, /desktop-release.yml@refs\/tags\/\$\{release.tag_name\}/);
});

test("automatic desktop jobs preserve tag-bound signing, full CI, e2e and notarization", () => {
  assert.match(workflow, /workflow_run:[\s\S]*workflows: \[Server CI\]/);
  assert.match(workflow, /group: desktop-release-.*'live'/);
  assert.match(workflow, /rollout=100\n/);
  assert.doesNotMatch(workflow, /production_verified_commit|UPDATE_ROLLOUT_PERCENTAGE/);
  for (const gate of ["verify-qualified-commit", "scripts/continuous-desktop-release.mjs compatible", "pnpm test:accessibility",
    "pnpm --filter @mdbase/connect-desktop test", "cosign sign-blob", "cosign verify-blob", "xcrun stapler validate"]) assert(workflow.includes(gate), gate);
  assert.match(workflow, /minimum=.*config\/desktop-update-minimum\.json/);
  assert.match(workflow, /--blocked-versions "\$\{UPDATE_BLOCKED_VERSIONS:-\}"/);
  assert.match(workflow, /needs: \[build, headless-package-smoke, cross-platform-release-tests, windows-package-smoke\]/);
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && startsWith\(github.ref, 'refs\/tags\/v'\) && inputs.operation == 'release'/);
});
