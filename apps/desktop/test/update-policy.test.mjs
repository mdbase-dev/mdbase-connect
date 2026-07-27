import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  channelForVersion,
  compareVersions,
  decideUpdate,
  parseUpdateManifest,
  rolloutBucket
} = require("../dist/main/update-policy.js");

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    version: "0.1.0-beta.9",
    tag: "v0.1.0-beta.9",
    channel: "beta",
    published_at: "2026-07-28T00:00:00.000Z",
    release_url: "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.9",
    notes: "A safer update.",
    rollout: { percentage: 100, seed: "v0.1.0-beta.9" },
    blocked_versions: [],
    targets: {
      "darwin-arm64": {
        mode: "automatic",
        action_url:
          "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.9",
        artifacts: [
          {
            name: "mdbase-connect-0.1.0-beta.9-macos-arm64.zip",
            url: "https://example.com/mdbase-connect-0.1.0-beta.9-macos-arm64.zip",
            sigstore_url:
              "https://example.com/mdbase-connect-0.1.0-beta.9-macos-arm64.zip.sigstore.json",
            sha256: "a".repeat(64),
            size: 1234,
            kind: "zip"
          }
        ]
      }
    },
    ...overrides
  };
}

test("semantic versions order prereleases without lexical mistakes", () => {
  assert.equal(compareVersions("0.1.0-beta.9", "0.1.0-beta.10"), -1);
  assert.equal(compareVersions("0.1.0-beta.10", "0.1.0"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3+build.4"), 0);
  assert.equal(compareVersions("1.2.3-alpha.1", "1.2.3-alpha.x"), -1);
  assert.equal(compareVersions("1.2.3-A", "1.2.3-a"), -1);
  assert.equal(
    compareVersions(
      "999999999999999999999999999999.2.3",
      "999999999999999999999999999998.999999999999999999999999.999"
    ),
    1
  );
  assert.equal(
    compareVersions("1.2.3-beta.999999999999999999999999999999", "1.2.3-beta.10"),
    1
  );
  assert.equal(channelForVersion("0.1.0-beta.9"), "beta");
  assert.equal(channelForVersion("0.1.0"), "stable");
  assert.throws(() => compareVersions("01.2.3", "1.2.3"), /Invalid semantic version/);
  assert.throws(() => compareVersions("1.2.3-beta.01", "1.2.3"), /Invalid semantic version/);
});

test("manifest parsing is strict at the trust boundary", () => {
  const parsed = parseUpdateManifest(manifest());
  assert.equal(parsed.version, "0.1.0-beta.9");
  assert.equal(parsed.targets["darwin-arm64"].mode, "automatic");

  assert.throws(
    () => parseUpdateManifest(manifest({ unexpected: true })),
    /unknown fields/
  );
  assert.throws(
    () => parseUpdateManifest(manifest({ tag: "v0.1.0-beta.8" })),
    /does not match/
  );
  assert.throws(
    () => parseUpdateManifest(manifest({ channel: "stable" })),
    /channel does not match/
  );
  assert.throws(
    () =>
      parseUpdateManifest(
        manifest({
          targets: {
            "darwin-arm64": {
              mode: "automatic",
              action_url: "http://example.com/update",
              artifacts: []
            }
          }
        })
      ),
    /HTTPS/
  );
  const unsafe = manifest();
  unsafe.targets["darwin-arm64"].artifacts[0].name = "../update.zip";
  assert.throws(() => parseUpdateManifest(unsafe), /unsafe/);

  const mismatchedKind = manifest();
  mismatchedKind.targets["darwin-arm64"].artifacts[0].kind = "dmg";
  assert.throws(() => parseUpdateManifest(mismatchedKind), /does not match its filename/);

  const duplicate = manifest();
  duplicate.targets["darwin-arm64"].artifacts.push({
    ...duplicate.targets["darwin-arm64"].artifacts[0]
  });
  assert.throws(() => parseUpdateManifest(duplicate), /duplicate names/);
});

test("rollout cohorts are stable and manual checks can opt in", () => {
  const parsed = parseUpdateManifest(
    manifest({ rollout: { percentage: 0, seed: "private-beta" } })
  );
  const automatic = decideUpdate({
    manifest: parsed,
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    installationId: "installation-a"
  });
  assert.deepEqual(automatic, { kind: "deferred", percentage: 0 });
  assert.equal(
    decideUpdate({
      manifest: parsed,
      currentVersion: "0.1.0-beta.8",
      channel: "beta",
      platformKey: "darwin-arm64",
      installationId: "installation-a",
      manual: true
    }).kind,
    "available"
  );
  assert.equal(
    rolloutBucket("installation-a", "release-1"),
    rolloutBucket("installation-a", "release-1")
  );
  assert.notEqual(
    rolloutBucket("installation-a", "release-1"),
    rolloutBucket("installation-b", "release-1")
  );
});

test("blocked installed versions bypass rollout while withdrawn targets fail closed", () => {
  const emergency = parseUpdateManifest(
    manifest({
      rollout: { percentage: 0, seed: "emergency" },
      blocked_versions: ["0.1.0-beta.8"]
    })
  );
  assert.equal(
    decideUpdate({
      manifest: emergency,
      currentVersion: "0.1.0-beta.8",
      channel: "beta",
      platformKey: "darwin-arm64",
      installationId: "outside-cohort"
    }).kind,
    "available"
  );
  const withdrawn = parseUpdateManifest(
    manifest({ blocked_versions: ["0.1.0-beta.9"] })
  );
  assert.equal(
    decideUpdate({
      manifest: withdrawn,
      currentVersion: "0.1.0-beta.8",
      channel: "beta",
      platformKey: "darwin-arm64",
      installationId: "installation-a"
    }).kind,
    "blocked"
  );
});

test("replayed manifests and cross-channel releases fail closed", () => {
  const parsed = parseUpdateManifest(manifest());
  assert.equal(
    decideUpdate({
      manifest: parsed,
      currentVersion: "0.1.0-beta.8",
      channel: "beta",
      platformKey: "darwin-arm64",
      installationId: "installation-a",
      highestTrustedVersion: "0.1.0-beta.10"
    }).kind,
    "blocked"
  );
  assert.equal(
    decideUpdate({
      manifest: parsed,
      currentVersion: "0.1.0-beta.8",
      channel: "stable",
      platformKey: "darwin-arm64",
      installationId: "installation-a"
    }).kind,
    "current"
  );
});
