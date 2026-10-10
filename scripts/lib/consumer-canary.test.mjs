import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectTarballs, overrideConfig, verifyInstalledPackages } from "../ci/consumer-canary.mjs";

const packages = {
  "@mdbase-dev/connect": "file:/candidate/connect.tgz",
  "@mdbase-dev/connect-protocol": "file:/candidate/protocol.tgz",
};

test("replaces every SDK dependency/pin and removes emergency patches without changing other dependencies", () => {
  const config = {
    dependencies: { "@mdbase-dev/connect": "beta.123", react: "19" },
    devDependencies: { "@mdbase-dev/connect-protocol": "file:vendor/old.tgz" },
    peerDependencies: { "@mdbase-dev/connect": "*" },
    optionalDependencies: { "@mdbase-dev/connect": "*" },
    overrides: { "@mdbase-dev/connect": "beta.123", "tool>@mdbase-dev/connect": "old", react: "19" },
    patchedDependencies: { "@mdbase-dev/connect@beta.123": "emergency.patch", "other@1": "other.patch" },
  };
  overrideConfig(config, packages);
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    assert.equal(config[section]["@mdbase-dev/connect"], packages["@mdbase-dev/connect"]);
  }
  assert.equal(config.devDependencies["@mdbase-dev/connect-protocol"], packages["@mdbase-dev/connect-protocol"]);
  assert.equal(config.dependencies.react, "19");
  assert.deepEqual(config.overrides, { react: "19" });
  assert.deepEqual(config.patchedDependencies, { "other@1": "other.patch" });
});

test("a consumer SDK dependency without a tarball fails instead of using npm", () => {
  assert.throws(() => overrideConfig({ dependencies: { "@mdbase-dev/ui": "1" } }, packages), /No candidate tarball/);
});

test("installed resolution accepts pnpm's relative file path and rejects npm, patches and other artifacts", () => {
  const entry = "@mdbase-dev/connect@file:../candidate/connect.tgz";
  const lock = { packages: { [entry]: { resolution: { tarball: "file:../candidate/connect.tgz" } } } };
  verifyInstalledPackages(lock, "/consumer", packages);
  for (const tarball of [undefined, "https://registry.npmjs.org/connect.tgz", "file:/other/connect.tgz"]) {
    assert.throws(() => verifyInstalledPackages({ packages: { [entry]: { resolution: { tarball } } } }, "/consumer", packages), /candidate SDK resolution/);
  }
  assert.throws(() => verifyInstalledPackages({}, "/consumer", packages), /not installed/);
  assert.throws(() => verifyInstalledPackages({ ...lock, patchedDependencies: { "@mdbase-dev/connect@0.1.0-beta.123": {} } }, "/consumer", packages), /SDK patch remains/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "consumer-canary-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "tarballs");
  await mkdir(output);
  return {
    output,
    async pack(name, version = "0.1.0-beta.123", dependencies = {}, suffix = "") {
      const source = join(root, `source-${name.replaceAll("/", "-")}${suffix}`);
      await mkdir(join(source, "package"), { recursive: true });
      await writeFile(join(source, "package/package.json"), JSON.stringify({ name, version, dependencies }));
      await writeFile(join(source, "package/code.js"), suffix);
      execFileSync("tar", ["-czf", join(output, `${name.replaceAll("/", "-")}${suffix}.tgz`), "-C", source, "package"]);
    },
  };
}

test("identifies tarballs by manifest and hashes bytes, not by version or filename", async (t) => {
  const f = await fixture(t);
  await f.pack("@mdbase-dev/connect", undefined, { "@mdbase-dev/connect-protocol": "0.1.0-beta.123" });
  await f.pack("@mdbase-dev/connect-protocol");
  const result = await inspectTarballs(f.output);
  assert.equal(result.version, "0.1.0-beta.123");
  assert.equal(Object.keys(result.packages).length, 2);
  assert.match(result.hashes["@mdbase-dev/connect"], /^[a-f0-9]{64}$/);
});

for (const [label, setup, pattern] of [
  ["missing connect", async () => {}, /connect tarball is missing/],
  ["mixed versions", async (f) => { await f.pack("@mdbase-dev/connect"); await f.pack("@mdbase-dev/connect-protocol", "different"); }, /versions differ/],
  ["duplicate packages", async (f) => { await f.pack("@mdbase-dev/connect"); await f.pack("@mdbase-dev/connect", undefined, {}, "duplicate"); }, /Duplicate candidate/],
  ["missing internal edge", async (f) => { await f.pack("@mdbase-dev/connect", undefined, { "@mdbase-dev/connect-protocol": "1" }); }, /Candidate edge/],
  ["foreign tarball", async (f) => { await f.pack("foreign"); }, /Unexpected tarball/],
]) {
  test(`rejects ${label}`, async (t) => {
    const f = await fixture(t);
    await setup(f);
    await assert.rejects(inspectTarballs(f.output), pattern);
  });
}
