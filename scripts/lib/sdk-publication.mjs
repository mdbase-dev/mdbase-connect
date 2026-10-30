import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.deepEqual(Object.keys(publication).sort(),
    ["environments", "prerelease", "productionRegistry", "ready", "workflow"]);
  assert.equal(publication.workflow, "publish-sdk-npm.yml");
  assert.equal(typeof publication.ready, "boolean");
  assert.equal(publication.productionRegistry, "https://registry.npmjs.org/");
  assert.deepEqual(publication.prerelease, {
    tagPrefix: "sdk-v", assets: { staging: "sdk-staging.tgz", lab: "sdk-lab.tgz" },
  });
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

export function exactSdkVersion(specifier) {
  assert.equal(typeof specifier, "string");
  assert.equal(specifier.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?/)?.[0], specifier,
    "production SDK dependency must be an exact npm version, never an alias, URL or tarball spec");
  return specifier;
}

export function sdkTarball(publication, environment) {
  sdkTarget(publication, environment);
  return environment === "production" ? "sdk-production.tgz" : publication.prerelease.assets[environment];
}

export function sdkReleaseTag(publication, version) {
  return publication.prerelease.tagPrefix + exactSdkVersion(version);
}

export function verifySdkArchive(archive, environment, version, commit, publication) {
  const member = name => JSON.parse(execFileSync("tar", ["-xOf", archive, `package/${name}`], { encoding: "utf8" }));
  const manifest = member("package.json");
  assert.equal(manifest.name, sdkTarget(publication, environment).package);
  assert.equal(manifest.version, exactSdkVersion(version));
  if (environment === "production") {
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.publishConfig?.registry, publication.productionRegistry);
  } else {
    assert.equal(manifest.private, true);
    assert.equal(manifest.publishConfig, undefined);
  }
  const provenance = member("dist/native/provenance.json");
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.schema, "mdbase-sdk/npm-publication/1");
  assert.equal(provenance.commit, commit);
  assert.equal(provenance.environment, environment);
  assert.deepEqual(provenance.trust, sdkTarget(publication, environment));
}
