import assert from "node:assert/strict";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import bundled from "../public/.well-known/mdbase-app.json" with { type: "json" };

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

