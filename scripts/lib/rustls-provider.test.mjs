import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("the workspace selects exactly one Rustls crypto provider", async () => {
  const manifest = await readFile(path.join(root, "Cargo.toml"), "utf8");
  const lock = await readFile(path.join(root, "Cargo.lock"), "utf8");
  const rustlsPackage = lock.match(/\[\[package\]\]\nname = "rustls"\n[\s\S]+?(?=\n\[\[package\]\])/u)?.[0];

  assert.match(manifest, /^rustls = .*features = \["aws-lc-rs", "std", "tls12"\]/mu);
  assert.match(manifest, /^reqwest = .*"rustls-tls-webpki-roots-no-provider"/mu);
  assert.match(manifest, /^sqlx = .*"tls-rustls-aws-lc-rs"/mu);
  assert.doesNotMatch(manifest, /tls-rustls-ring/u);
  assert.ok(rustlsPackage, "Cargo.lock must contain Rustls");
  assert.match(rustlsPackage, /\n "aws-lc-rs",/u);
  assert.doesNotMatch(rustlsPackage, /\n "ring",/u);
});
