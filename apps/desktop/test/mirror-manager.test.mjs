import assert from "node:assert/strict";
import test from "node:test";
import { pathsOverlap } from "../dist/main/mirror-manager.js";

test("hosted mirrors reject the same folder and nested folders", () => {
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted"), true);
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted/nested"), true);
  assert.equal(pathsOverlap("/vault/hosted/nested", "/vault/hosted"), true);
});

test("hosted mirrors allow sibling folders with similar names", () => {
  assert.equal(pathsOverlap("/vault/hosted", "/vault/hosted-copy"), false);
  assert.equal(pathsOverlap("/vault/one", "/vault/two"), false);
});
