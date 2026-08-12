import assert from "node:assert/strict";
import test from "node:test";
import { assertEditorManifest } from "./verify-deployment-manifest.mjs";

const homepage = "https://editor.mdbase.dev/";

test("accepts collection-wide binary file access", () => {
  assert.doesNotThrow(() => assertEditorManifest(manifest(), homepage));
});

test("accepts the exact configured Connect callback", () => {
  const value = manifest();
  value.redirect_uris.push("https://editor.mdbase.dev/?server=https%3A%2F%2Fconnect-staging.mdbase.dev");
  assert.doesNotThrow(() => assertEditorManifest(value, homepage, "https://connect-staging.mdbase.dev"));
});

test("rejects a deployment without the configured Connect callback", () => {
  assert.throws(
    () => assertEditorManifest(manifest(), homepage, "https://connect-staging.mdbase.dev"),
    /redirect URIs must include/
  );
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
