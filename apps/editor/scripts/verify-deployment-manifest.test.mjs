import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertEditorManifest } from "./verify-deployment-manifest.mjs";

const homepage = "https://editor.mdbase.dev/";

for (const version of [1, 2]) {
  test(`accepts v${version} collection-wide binary file access`, () => {
    assert.doesNotThrow(() => assertEditorManifest(manifest(version), homepage));
  });

  test(`accepts the exact configured v${version} Connect callback`, () => {
    const value = manifest(version);
    value.redirect_uris.push("https://editor.mdbase.dev/?server=https%3A%2F%2Fconnect-staging.mdbase.dev");
    assert.doesNotThrow(() => assertEditorManifest(value, homepage, "https://connect-staging.mdbase.dev"));
  });

  test(`rejects v${version} without the configured Connect callback`, () => {
    assert.throws(
      () => assertEditorManifest(manifest(version), homepage, "https://connect-staging.mdbase.dev"),
      /redirect URIs must include/
    );
  });

  for (const [name, mutate, expected] of [
    ["file actions", (value) => { delete value.requirements.files; }, /file list action/],
    ["collection scope", (value) => { value.requirements.files.scope = { kind: "selected_folders", folders: ["Media"] }; }, /scope must cover the collection/],
    ["full collection access", (value) => { value.requirements.access = "scoped"; }, /access must be full_collection/],
    ["homepage", (value) => { value.homepage = "https://other.invalid/"; }, /homepage must be/],
    ["first redirect", (value) => { value.redirect_uris = []; }, /first redirect URI/]
  ]) {
    test(`rejects v${version} without ${name}`, () => {
      const value = manifest(version);
      mutate(value);
      assert.throws(() => assertEditorManifest(value, homepage), expected);
    });
  }
}

test("retains the legacy omitted-version file-intent check", () => {
  const value = manifest(1);
  delete value.requirements.capabilities.contract_version;
  assert.doesNotThrow(() => assertEditorManifest(value, homepage));
});

test("retains both required v1 file capabilities", () => {
  for (const action of ["list", "read"]) {
    const value = manifest(1);
    value.requirements.capabilities.required = value.requirements.capabilities.required.filter(
      (capability) => capability !== `files.${action}`
    );
    assert.throws(() => assertEditorManifest(value, homepage), new RegExp(`files\\.${action} capability`));
  }
});

test("v2 optional or legacy actions cannot replace required binary file access", () => {
  for (const action of ["list", "read"]) {
    const value = manifest(2);
    value.requirements.files.required = value.requirements.files.required.filter((item) => item !== action);
    value.requirements.files.optional.push(action);
    assert.throws(() => assertEditorManifest(value, homepage), new RegExp(`file ${action} action`));
  }
  const legacy = manifest(2);
  delete legacy.requirements.files.required;
  legacy.requirements.files.actions = ["list", "read"];
  assert.throws(() => assertEditorManifest(legacy, homepage), /file list action/);
});

test("rejects mixed v2 and legacy file-action representations", () => {
  const value = manifest(2);
  value.requirements.files.actions = ["list", "read"];
  assert.throws(() => assertEditorManifest(value, homepage), /v2 file requirements must not contain legacy actions/);
});

test("fails closed on unknown or malformed explicit capability versions", () => {
  for (const version of [0, 3, null, "2"]) {
    const value = manifest(1);
    value.requirements.capabilities.contract_version = version;
    assert.throws(() => assertEditorManifest(value, homepage), /unsupported capability contract version/);
  }
});

test("accepts the actual production manifest generator output", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "mdbase-editor-manifest-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  const writer = join(directory, "scripts", "write-manifest.mjs");
  copyFileSync(new URL("./write-manifest.mjs", import.meta.url), writer);
  execFileSync(process.execPath, [writer], {
    env: {
      ...process.env,
      MDBASE_EDITOR_ORIGIN: homepage,
      MDBASE_EDITOR_BASE_PATH: "/",
      MDBASE_CONNECT_URL: ""
    }
  });
  const value = JSON.parse(readFileSync(join(directory, "public", ".well-known", "mdbase-app.json"), "utf8"));
  assert.equal(value.requirements.capabilities.contract_version, 2);
  assert.doesNotThrow(() => assertEditorManifest(value, homepage));
});

function manifest(version) {
  return {
    homepage,
    redirect_uris: [homepage],
    requirements: {
      access: "full_collection",
      capabilities: {
        contract_version: version,
        required: version === 1 ? ["files.list", "files.read"] : ["collection.read"]
      },
      files: version === 1
        ? { actions: ["list", "read"], scope: { kind: "collection" } }
        : { required: ["list", "read"], optional: ["add"], scope: { kind: "collection" } }
    }
  };
}
