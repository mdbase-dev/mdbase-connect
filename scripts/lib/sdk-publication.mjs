import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const sdkPackages = Object.freeze({
  production: "@mdbase-dev/sdk",
  staging: "@mdbase-dev/sdk-staging",
  lab: "@mdbase-dev/sdk-lab",
});

export function checkedSdkAsset(file, pin) {
  const bytes = readFileSync(file);
  assert.equal(bytes.length, pin.bytes, `${file}: byte length mismatch`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.sha256,
    `${file}: SHA-256 mismatch`);
  return bytes;
}

export function validateSdkPublication(publication, root) {
  assert.deepEqual(Object.keys(publication).sort(), ["environments", "ready", "workflow"]);
  assert.equal(publication.workflow, "publish-sdk-npm.yml");
  assert.equal(typeof publication.ready, "boolean");
  assert.deepEqual(Object.keys(publication.environments).sort(), Object.keys(sdkPackages).sort());
  const hashes = new Set();
  for (const [environment, packageName] of Object.entries(sdkPackages)) {
    const pin = publication.environments[environment];
    assert.deepEqual(Object.keys(pin).sort(),
      ["bytes", "cpOrigin", "logOrigin", "package", "sha256", "sourceCommit", "sourceVersion"]);
    assert.equal(pin.package, packageName);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.match(pin.sourceCommit, /^[a-f0-9]{40}$/);
    assert.match(pin.sourceVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert(Number.isSafeInteger(pin.bytes) && pin.bytes > 0);
    assert(!hashes.has(pin.sha256), "environments must not share trust assets");
    hashes.add(pin.sha256);
    const asset = JSON.parse(checkedSdkAsset(join(root, "config/next-trust", `${environment}.json`), pin));
    assert.equal(asset.environment, environment);
    assert.equal(asset.source.repository, "mdbase-dev/mdbase-connect");
    assert.equal(asset.source.commit, pin.sourceCommit);
    assert.equal(asset.source.version, pin.sourceVersion);
    assert.equal(asset.control_plane_origin, pin.cpOrigin);
    assert.equal(asset.log_origin, pin.logOrigin);
    for (const origin of [pin.cpOrigin, pin.logOrigin]) {
      const url = new URL(origin);
      assert.equal(url.protocol, "https:");
      assert.equal(url.origin, origin);
    }
  }
}

export function sdkTarget(publication, environment) {
  assert(Object.hasOwn(sdkPackages, environment), "unknown SDK environment");
  const pin = publication.environments[environment];
  assert.equal(pin.package, sdkPackages[environment], "SDK package/environment mismatch");
  return pin;
}

export function requireSdkPublicationReady(publication) {
  assert.equal(publication.ready, true,
    "SDK publication blocked: port the outstanding mdbase-next commits and qualify the source-built SDK first");
}
