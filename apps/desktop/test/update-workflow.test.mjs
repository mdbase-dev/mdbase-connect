import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("release workflow signs and verifies the update manifest before publication", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/desktop-release.yml"),
    "utf8"
  );
  const generate = workflow.indexOf("scripts/generate-update-manifest.mjs");
  const sign = workflow.indexOf(
    "cosign sign-blob",
    workflow.indexOf("Create and verify signed update manifest")
  );
  const verify = workflow.indexOf("cosign verify-blob", sign);
  const publish = workflow.indexOf('gh release create "$GITHUB_REF_NAME"');
  assert.ok(generate >= 0);
  assert.ok(sign > generate);
  assert.ok(verify > sign);
  assert.ok(publish > verify);
  assert.match(
    workflow,
    /certificate-identity "https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\/\.github\/workflows\/desktop-release\.yml@\$\{GITHUB_REF\}"/
  );
});

test("unsigned previews cannot be described as automatic targets", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/desktop-release.yml"),
    "utf8"
  );
  const description = workflow.slice(
    workflow.indexOf("- name: Describe platform update"),
    workflow.indexOf("- name: Sign and verify Microsoft Store", workflow.indexOf("- name: Describe platform update"))
  );
  assert.match(description, /MACOS_RELEASE_MODE.*signed[\s\S]*--mode automatic/);
  assert.match(description, /--mode manual[\s\S]*-UNSIGNED\.dmg/);
  assert.match(description, /WINDOWS_STORE_MODE.*store[\s\S]*--mode store/);
  assert.match(description, /WINDOWS_STORE_PRODUCT_ID/);
});

test("update installation bypasses the tray window's hide-on-close behavior", async () => {
  const main = await readFile(
    resolve(repositoryRoot, "apps/desktop/src/main/main.ts"),
    "utf8"
  );
  const updateQuit = main.indexOf('autoUpdater.on("before-quit-for-update"');
  const hideOnClose = main.indexOf('mainWindow.on("close"');
  assert.ok(updateQuit >= 0);
  assert.ok(updateQuit < hideOnClose);
  assert.match(
    main.slice(updateQuit, hideOnClose),
    /before-quit-for-update"[\s\S]*quitting = true/
  );
});
