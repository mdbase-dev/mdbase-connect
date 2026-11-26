import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("server uses the canonical manifest validator", async () => {
  const server = await readFile(new URL("services/server/src/manifest.ts", root), "utf8");
  assert.match(
    server,
    /@mdbase-dev\/connect-protocol\/manifest/,
    "server must import the canonical manifest validator"
  );
  assert.doesNotMatch(
    server,
    /mdbase-app\.schema\.json|z\.object\(\{\s*manifest_version/,
    "server must not define a parallel application manifest schema"
  );
});
