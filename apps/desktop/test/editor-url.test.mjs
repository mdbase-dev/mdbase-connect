import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildEditorUrl } = require("../dist/main/editor-url.js");

test("editor links carry the opaque collection identity", () => {
  assert.equal(
    buildEditorUrl("collection id/with punctuation", "https://editor.mdbase.dev/"),
    "https://editor.mdbase.dev/?collection=collection+id%2Fwith+punctuation"
  );
  assert.equal(
    buildEditorUrl("staging-collection", "https://editor-staging.mdbase.dev/?preview=1"),
    "https://editor-staging.mdbase.dev/?preview=1&collection=staging-collection"
  );
});

test("editor links reject invalid IDs and unsafe base URLs", () => {
  assert.throws(() => buildEditorUrl("", "https://editor.mdbase.dev/"), /Invalid collection ID/);
  assert.throws(
    () => buildEditorUrl("collection", "http://editor.mdbase.dev/"),
    /credential-free HTTPS URL/
  );
  assert.throws(
    () => buildEditorUrl("collection", "https://user:secret@editor.mdbase.dev/"),
    /credential-free HTTPS URL/
  );
});
