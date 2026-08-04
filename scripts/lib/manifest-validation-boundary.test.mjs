import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("server and public developer tooling use the canonical manifest validator", async () => {
  const [server, devkit] = await Promise.all([
    readFile(new URL("services/server/src/manifest.ts", root), "utf8"),
    readFile(new URL("packages/devkit/src/index.ts", root), "utf8")
  ]);

  for (const [surface, source] of [["server", server], ["connect-dev", devkit]]) {
    assert.match(
      source,
      /@mdbase-dev\/connect-protocol\/manifest/,
      `${surface} must import the canonical manifest validator`
    );
    assert.doesNotMatch(
      source,
      /mdbase-app\.schema\.json|z\.object\(\{\s*manifest_version/,
      `${surface} must not define a parallel application manifest schema`
    );
  }
});
