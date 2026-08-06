import assert from "node:assert/strict";
import test from "node:test";
import { assertEditorManifest } from "./verify-deployment-manifest.mjs";

const homepage = "https://editor.mdbase.dev/";

test("accepts collection-wide binary file access", () => {
  assert.doesNotThrow(() => assertEditorManifest(manifest(), homepage));
});

for (const [name, mutate, expected] of [
  ["file capabilities", (value) => { value.requirements.capabilities.required = []; }, /files\.list capability/],
  ["file actions", (value) => { delete value.requirements.files; }, /file list action/],
  ["collection scope", (value) => { value.requirements.files.scope = { kind: "selected_folders", folders: ["Media"] }; }, /scope must cover the collection/]
]) {
  test(`rejects a deployment without ${name}`, () => {
    const value = manifest();
    mutate(value);
    assert.throws(() => assertEditorManifest(value, homepage), expected);
  });
}

function manifest() {
  return {
    homepage,
    redirect_uris: [homepage],
    requirements: {
      access: "full_collection",
      capabilities: { required: ["files.list", "files.read"] },
      files: { actions: ["list", "read"], scope: { kind: "collection" } }
    }
  };
}
