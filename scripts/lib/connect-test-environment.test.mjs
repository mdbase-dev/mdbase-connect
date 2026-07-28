import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeProjectName } from "./connect-test-environment.mjs";

test("keeps already-valid Compose project names stable", () => {
  assert.equal(
    sanitizeProjectName("mdbase-connect-e2e-1234-abcd"),
    "mdbase-connect-e2e-1234-abcd"
  );
});

test("preserves uniqueness when long project names share a prefix", () => {
  const shared = `bughunt-${"x".repeat(55)}`;
  const first = sanitizeProjectName(`${shared}-first`);
  const second = sanitizeProjectName(`${shared}-second`);

  assert.notEqual(first, second);
  assert.ok(first.length <= 63);
  assert.ok(second.length <= 63);
  assert.match(first, /^[a-z0-9][a-z0-9_-]*$/);
  assert.match(second, /^[a-z0-9][a-z0-9_-]*$/);
});

test("preserves uniqueness when normalization changes project names", () => {
  assert.notEqual(
    sanitizeProjectName("desktop suite"),
    sanitizeProjectName("desktop-suite")
  );
});
