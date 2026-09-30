import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
test("PWA identity is stable and starts without auth or document parameters", async () => {
  const manifest = JSON.parse(await readFile(new URL("public/manifest.webmanifest", root), "utf8"));
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.name, /^mdbase (writer|reader|editor)$/);
  const html = await readFile(new URL("index.html", root), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
    assert.ok(icon, `Missing ${size}px icon`);
    assert.equal(icon.type, "image/png");
    const png = await readFile(new URL(`public${icon.src}`, root));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  const apple = await readFile(new URL("public/apple-touch-icon.png", root));
  assert.equal(apple.readUInt32BE(16), 180);
  assert.equal(apple.readUInt32BE(20), 180);
});
