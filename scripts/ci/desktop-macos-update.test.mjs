import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { plan, releaseTag, updatePair } from "./desktop-macos-update.mjs";

const signed = (number) => {
  const version = `0.1.0-beta.${number}`;
  return {
    tag_name: `v${version}`,
    assets: ["arm64", "x64"].flatMap((arch) => [
      `mdbase-connect-${version}-macos-${arch}.dmg`,
      `mdbase-connect-${version}-macos-${arch}.zip`
    ]).map((name) => ({ name }))
  };
};
const unsigned = (number) => {
  const version = `0.1.0-beta.${number}`;
  return {
    tag_name: `v${version}`,
    assets: [`mdbase-connect-${version}-macos-arm64-UNSIGNED.dmg`, `mdbase-connect-${version}-macos-arm64-UNSIGNED.zip`]
      .map((name) => ({ name }))
  };
};
const releases = [signed(208), signed(190), signed(185)];
const pair = (overrides = {}) => updatePair({ releases, arch: "arm64", ...overrides });

test("by default the previous release updates to the newest", () => {
  assert.deepEqual(pair(), { from: "v0.1.0-beta.190", to: "v0.1.0-beta.208", dmg: "mdbase-connect-0.1.0-beta.190-macos-arm64.dmg" });
  assert.equal(pair({ arch: "x64" }).dmg, "mdbase-connect-0.1.0-beta.190-macos-x64.dmg");
});

test("a dispatch chooses an older release, with or without the v", () => {
  assert.equal(pair({ from: "0.1.0-beta.185" }).from, "v0.1.0-beta.185");
  assert.equal(pair({ from: "v0.1.0-beta.185", to: "0.1.0-beta.208" }).from, "v0.1.0-beta.185");
  assert.equal(releaseTag(" "), undefined);
  assert.throws(() => releaseTag("beta.190"), /Not a release version/);
});

test("the target must be the newest release, because the app always updates to the newest", () => {
  assert.throws(() => pair({ to: "v0.1.0-beta.190" }), /not the newest desktop release \(v0\.1\.0-beta\.208\)/);
  assert.throws(() => pair({ to: "v0.1.0-beta.999" }), /not a published desktop release/);
});

test("the older release must be published and older", () => {
  assert.throws(() => pair({ from: "v0.1.0-beta.208" }), /not older than/);
  assert.throws(() => pair({ from: "v0.1.0-beta.1" }), /not a published desktop release/);
  assert.throws(() => updatePair({ releases: [signed(208)], arch: "arm64" }), /No desktop release was published before/);
  assert.throws(() => updatePair({ releases: [], arch: "arm64" }), /No desktop release has been published/);
});

test("an explicitly unsigned macOS preview on either side skips the test", () => {
  assert.match(updatePair({ releases: [unsigned(208), signed(190)], arch: "arm64" }).skip,
    /^v0\.1\.0-beta\.208 is an explicitly unsigned macOS preview\./);
  assert.match(updatePair({ releases: [signed(208), unsigned(190)], arch: "arm64" }).skip,
    /^v0\.1\.0-beta\.190 is an explicitly unsigned/);
  assert.match(updatePair({ releases: [unsigned(208), unsigned(190)], arch: "arm64" }).skip,
    /^v0\.1\.0-beta\.190 and v0\.1\.0-beta\.208 are explicitly unsigned macOS previews\./);
});

test("a release without any macOS build fails instead of skipping", () => {
  assert.throws(() => updatePair({ releases: [{ tag_name: "v0.1.0-beta.208", assets: [] }, signed(190)], arch: "arm64" }),
    /neither a signed nor an unsigned macOS arm64 zip/);
});

test("plan writes the pair or the skip reason for the workflow", () => {
  const output = join(mkdtempSync(join(tmpdir(), "macos-update-")), "output");
  plan({ ARCH: "arm64", TO: "v0.1.0-beta.208", GITHUB_OUTPUT: output }, releases);
  assert.equal(readFileSync(output, "utf8"),
    "skip=false\nfrom=v0.1.0-beta.190\nto=v0.1.0-beta.208\ndmg=mdbase-connect-0.1.0-beta.190-macos-arm64.dmg\n");
  const skipped = join(mkdtempSync(join(tmpdir(), "macos-update-")), "output");
  plan({ ARCH: "arm64", GITHUB_OUTPUT: skipped }, [unsigned(208), signed(190)]);
  assert.match(readFileSync(skipped, "utf8"), /^skip=true\nreason=v0\.1\.0-beta\.208 is an explicitly unsigned/);
});
