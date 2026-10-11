import assert from "node:assert/strict";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import bundled from "../public/.well-known/mdbase-app.json" with { type: "json" };

it("generates a self-registered HTTPS LAB declaration with exact extra origin, refusing cross-environment or noncanonical input", () => {
  const root = mkdtempSync(join(tmpdir(), "editor-lab-manifest-"));
  try {
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts/write-manifest.mjs");
    copyFileSync(new URL("./write-manifest.mjs", import.meta.url), script);
    const env = { ...process.env, MDBASE_ENV: "lab", MDBASE_EDITOR_ORIGIN: "https://editor-lab.mdbase.dev", MDBASE_EDITOR_BASE_PATH: "/",
      MDBASE_CONNECT_URL: "https://connect-lab.mdbase.dev", MDBASE_EDITOR_LAB_ORIGIN: "http://127.0.0.1:48219" };
    assert.equal(spawnSync(process.execPath, [script], {env}).status, 0);
    const manifest = JSON.parse(readFileSync(join(root, "public/.well-known/mdbase-app.json"), "utf8"));
    assert.equal(manifest.homepage, "https://editor-lab.mdbase.dev/");
    assert.deepEqual(manifest.installation_origins, {lab: {"app-runtime": [env.MDBASE_EDITOR_LAB_ORIGIN]}});
    assert.deepEqual(manifest.requirements, bundled.requirements);
    for (const origin of ["http://127.0.0.1:48219/", "http://other.example:48219", "http://user:pass@127.0.0.1:48219", "http://127.0.0.1:48219?x", "*"]) {
      assert.notEqual(spawnSync(process.execPath, [script], {env: {...env, MDBASE_EDITOR_LAB_ORIGIN: origin}}).status, 0);
    }
    assert.notEqual(spawnSync(process.execPath, [script], {env: {...env, MDBASE_ENV: "production"}}).status, 0);
    assert.notEqual(spawnSync(process.execPath, [script], {env: {...env, MDBASE_EDITOR_ORIGIN: env.MDBASE_EDITOR_LAB_ORIGIN}}).status, 0);
    assert.equal(parseVersionedAppManifest(manifest).contractVersion, 2);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

it("generates the bundled v2 artifact normally and keeps callback configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "editor-manifest-"));
  const originalEnv = { ...process.env };
  try {
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts/write-manifest.mjs");
    copyFileSync(new URL("./write-manifest.mjs", import.meta.url), script);
    const generate = async (origin, base, server) => {
      process.env.MDBASE_EDITOR_ORIGIN = origin;
      process.env.MDBASE_EDITOR_BASE_PATH = base;
      process.env.MDBASE_CONNECT_URL = server;
      await import(`${pathToFileURL(script).href}?origin=${encodeURIComponent(origin)}`);
      return JSON.parse(readFileSync(join(root, "public/.well-known/mdbase-app.json"), "utf8"));
    };
    assert.deepEqual(await generate("https://editor.mdbase.dev", "/", ""), bundled);
    const configured = await generate("https://editor.example/", "workspace", "https://connect.example/path");
    assert.deepEqual(configured.redirect_uris, [
      "https://editor.example/workspace/",
      "https://editor.example/workspace/?server=https%3A%2F%2Fconnect.example"
    ]);
    assert.deepEqual(configured.requirements, bundled.requirements);
    assert.equal(parseVersionedAppManifest(configured).contractVersion, 2);
  } finally {
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

