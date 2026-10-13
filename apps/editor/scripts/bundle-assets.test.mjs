import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadBundleAssets } from "./bundle-assets.mjs";

async function fixture(run) {
  const root = await mkdtemp(fileURLToPath(new URL("../.bundle-size-test-", import.meta.url)));
  try {
    await mkdir(`${root}/dist/assets`, { recursive: true });
    await mkdir(`${root}/public`);
    await writeFile(`${root}/dist/assets/app.js`, "compiled app");
    await writeFile(`${root}/public/theme.css`, "public style");
    await writeFile(`${root}/dist/theme.css`, "public style");
    const content = "generated registration";
    await writeFile(`${root}/dist/mdbase-shell-register.js`, content);
    await writeFile(`${root}/dist/mdbase-shell-sw.js`, `installOfflineShell(self, ${JSON.stringify({ base: "/", assets: [{ path: "mdbase-shell-register.js", sha256: createHash("sha256").update(content).digest("hex") }] })});`);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("classifies bundle, copied public, and hash-verified generated files; includes all bytes", async () => {
  await fixture(async root => {
    const assets = await loadBundleAssets(root, ["/assets/app.js", "/theme.css", "/mdbase-shell-register.js", "/assets/app.js"]);
    assert.deepEqual(assets.map(asset => asset.kind), ["bundle", "public", "generated"]);
    assert.deepEqual(assets.map(asset => asset.content.toString()), ["compiled app", "public style", "generated registration"]);
  });
});

test("refuses changed generated registration and changed copied public files", async () => {
  await fixture(async root => {
    await writeFile(`${root}/dist/mdbase-shell-register.js`, "changed");
    await assert.rejects(loadBundleAssets(root, ["/mdbase-shell-register.js"]), /shell manifest/);
    await writeFile(`${root}/dist/theme.css`, "changed");
    await assert.rejects(loadBundleAssets(root, ["/theme.css"]), /declared public source/);
  });
});

test("refuses unknown root files, missing files, remote references, queries and traversal", async () => {
  await fixture(async root => {
    await writeFile(`${root}/dist/unknown.js`, "not declared");
    for (const path of ["/unknown.js", "/assets/missing.js", "https://other.test/assets/app.js", "//other.test/assets/app.js", "/assets/app.js?secret=not-real", "/assets/app.js#fragment", "/assets/../theme.css", "/assets/%2e%2e/theme.css", "/assets/%2f../theme.css", "../private.js"]) {
      await assert.rejects(loadBundleAssets(root, [path]));
    }
  });
});

test("refuses a bundle symlink escaping the distribution", async () => {
  await fixture(async root => {
    await writeFile(`${root}/outside.js`, "outside");
    await symlink(`${root}/outside.js`, `${root}/dist/assets/escape.js`);
    await assert.rejects(loadBundleAssets(root, ["/assets/escape.js"]), /escapes/);
  });
});
