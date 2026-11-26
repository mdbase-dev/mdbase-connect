import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  channelForVersion,
  compareVersions,
  decideUpdate,
  parseRolloutDocument,
  parseUpdateManifest,
  rolloutBucket,
  UPDATE_SPACING_MS
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
  assert.deepEqual(automatic, { kind: "deferred", reason: "held", percentage: 0 });
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

test("blocked installed versions bypass rollout and must update; withdrawn targets fail closed", () => {
  const emergency = parseUpdateManifest(
    manifest({
      rollout: { percentage: 0, seed: "emergency" },
      blocked_versions: ["0.1.0-beta.8"]
    })
  );
  const forced = decideUpdate({
    manifest: emergency,
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    installationId: "outside-cohort"
  });
  assert.equal(forced.kind, "available");
  assert.equal(forced.required, true);
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

test("a beta installation takes a stable release; a stable installation never takes a beta", () => {
  const stable = parseUpdateManifest(manifest({
    version: "0.1.0",
    tag: "v0.1.0",
    channel: "stable",
    release_url: "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0",
    rollout: { percentage: 100, seed: "v0.1.0" }
  }));
  const decide = (target, currentVersion, channel, extra = {}) => decideUpdate({
    manifest: target,
    currentVersion,
    channel,
    platformKey: "darwin-arm64",
    installationId: "installation-a",
    ...extra
  }).kind;
  assert.equal(decide(stable, "0.1.0-beta.200", "beta"), "available");
  // The bridge keeps every other guard: replay floor, withdrawal and version order.
  assert.equal(decide(stable, "0.1.0-beta.200", "beta", { highestTrustedVersion: "0.1.1" }), "blocked");
  assert.equal(
    decide(parseUpdateManifest({ ...structuredClone(stable), blocked_versions: ["0.1.0"] }), "0.1.0-beta.200", "beta"),
    "blocked"
  );
  assert.equal(decide(stable, "0.1.1-beta.1", "beta"), "current");
  assert.equal(decide(parseUpdateManifest(manifest({ version: "0.1.1-beta.1", tag: "v0.1.1-beta.1",
    release_url: "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.1-beta.1" })), "0.1.0", "stable"), "current");
});

function rollout(overrides = {}) {
  return parseRolloutDocument({
    schema: "mdbase-desktop-rollout/1",
    tag: "v0.1.0-beta.9",
    version: "0.1.0-beta.9",
    issued_at: "2026-11-17T06:00:00.000Z",
    early_access: true,
    percentage: 0,
    ...overrides
  });
}

/** An installation id whose bucket for `seed` is at or above `bucket`, or below it. */
function installationIn(seed, predicate) {
  for (let index = 0; ; index += 1) {
    const id = `installation-${index}`;
    if (predicate(rolloutBucket(id, seed))) return id;
  }
}

function decide(input) {
  return decideUpdate({
    manifest: parseUpdateManifest(manifest()),
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    installationId: "installation-a",
    ...input
  });
}

test("the early stage reaches early-access installations only", () => {
  const early = rollout({ early_access: true, percentage: 0 });
  assert.equal(decide({ rollout: early, earlyAccess: true }).kind, "available");
  assert.deepEqual(decide({ rollout: early }), { kind: "deferred", reason: "early_access", percentage: 0 });
});

test("a held release reaches nobody automatically, early access included", () => {
  const held = rollout({ early_access: false, percentage: 0 });
  assert.deepEqual(decide({ rollout: held, earlyAccess: true }), { kind: "deferred", reason: "held", percentage: 0 });
  assert.equal(decide({ rollout: held, manual: true }).kind, "available");
});

test("a percentage stage reaches the installations below it and stays stable as it widens", () => {
  const seed = "v0.1.0-beta.9";
  const inside = installationIn(seed, (bucket) => bucket < 500);
  const outside = installationIn(seed, (bucket) => bucket >= 2500);
  assert.equal(decide({ rollout: rollout({ percentage: 5 }), installationId: inside }).kind, "available");
  assert.deepEqual(
    decide({ rollout: rollout({ percentage: 5 }), installationId: outside }),
    { kind: "deferred", reason: "rollout", percentage: 5 }
  );
  assert.equal(decide({ rollout: rollout({ percentage: 25 }), installationId: inside }).kind, "available");
  assert.equal(decide({ rollout: rollout({ percentage: 100 }), installationId: outside }).kind, "available");
});

test("a release without a rollout document follows its signed manifest", () => {
  assert.equal(decide({ rollout: null }).kind, "available");
  assert.equal(decide({}).kind, "available");
});

test("an unverifiable rollout defers rather than guessing, except for manual and required updates", () => {
  assert.deepEqual(decide({ rollout: "unavailable", earlyAccess: true }), { kind: "deferred", reason: "rollout_unavailable", percentage: 0 });
  assert.equal(decide({ rollout: "unavailable", manual: true }).kind, "available");
  const forced = decideUpdate({
    manifest: parseUpdateManifest(manifest({ blocked_versions: ["0.1.0-beta.8"] })),
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    installationId: "installation-a",
    rollout: "unavailable"
  });
  assert.equal(forced.kind, "available");
  assert.equal(forced.required, true);
});

test("installations without early access take at most one optional update a day", () => {
  const since = "2026-11-17T00:00:00.000Z";
  const now = Date.parse(since) + 6 * 60 * 60 * 1000;
  assert.deepEqual(decide({ currentVersionSince: since, now }), {
    kind: "deferred",
    reason: "spacing",
    percentage: 100,
    until: new Date(Date.parse(since) + UPDATE_SPACING_MS).toISOString()
  });
  assert.equal(decide({ currentVersionSince: since, now: Date.parse(since) + UPDATE_SPACING_MS }).kind, "available");
  assert.equal(decide({ currentVersionSince: since, now, earlyAccess: true }).kind, "available");
  assert.equal(decide({ currentVersionSince: since, now, manual: true }).kind, "available");
  const required = decideUpdate({
    manifest: parseUpdateManifest(manifest({ blocked_versions: ["0.1.0-beta.8"] })),
    currentVersion: "0.1.0-beta.8",
    channel: "beta",
    platformKey: "darwin-arm64",
    installationId: "installation-a",
    currentVersionSince: since,
    now
  });
  assert.equal(required.kind, "available");
});

test("a version the newest release withdraws is never taken and makes its installations update", () => {
  assert.deepEqual(decide({ withdrawn: ["0.1.0-beta.9"], manual: true }).kind, "blocked");
  const fromWithdrawn = decide({ withdrawn: ["0.1.0-beta.8"], rollout: rollout({ early_access: false }) });
  assert.equal(fromWithdrawn.kind, "available");
  assert.equal(fromWithdrawn.required, true);
});

test("rollout documents are parsed strictly", () => {
  assert.throws(() => rollout({ extra: true }), /unexpected|Unknown|key/i);
  assert.throws(() => rollout({ schema: "mdbase-desktop-rollout/2" }), /schema/);
  assert.throws(() => rollout({ tag: "v0.1.0-beta.10" }), /does not match/);
  assert.throws(() => rollout({ issued_at: "yesterday" }), /issued_at/);
  assert.throws(() => rollout({ early_access: "yes" }), /early_access/);
  assert.throws(() => rollout({ percentage: -1 }), /percentage/);
  assert.throws(() => rollout({ percentage: Number.NaN }), /percentage/);
});
