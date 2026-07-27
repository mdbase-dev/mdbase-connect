import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  ElectronUpdateBackend,
  localUpdateServer,
  parseRange,
  runtimeNeedsReconciliation
} = require("../dist/main/electron-update-backend.js");

function manifest() {
  return {
    version: "0.1.0-beta.9",
    notes: "Verified release.",
    published_at: "2026-07-28T00:00:00.000Z"
  };
}

test("loopback update feed serves only the verified archive and supports ranges", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-feed-"));
  const archive = join(directory, "update.zip");
  await writeFile(archive, Buffer.from("0123456789"));
  const server = await localUpdateServer(archive, manifest());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const feed = await fetch(`${origin}/feed`);
  assert.equal(feed.status, 200);
  const payload = await feed.json();
  assert.equal(payload.name, "0.1.0-beta.9");
  assert.equal(payload.url, `${origin}/artifact`);

  const partial = await fetch(`${origin}/artifact`, {
    headers: { range: "bytes=2-5" }
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await partial.text(), "2345");

  const missing = await fetch(`${origin}/anything-else`);
  assert.equal(missing.status, 404);
});

test("loopback feed rejects invalid methods and ranges", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-feed-"));
  const archive = join(directory, "update.zip");
  await writeFile(archive, Buffer.from("0123456789"));
  const server = await localUpdateServer(archive, manifest());
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const post = await fetch(`${origin}/artifact`, { method: "POST" });
  assert.equal(post.status, 405);
  const invalid = await fetch(`${origin}/artifact`, {
    headers: { range: "bytes=9-100" }
  });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
  assert.throws(() => parseRange("bytes=-2", 10), /Invalid update range/);
  assert.throws(() => parseRange("bytes=2-1", 10), /Invalid update range/);
});

test("runtime reconciliation covers stale and stopped services without restarting a match", () => {
  assert.equal(
    runtimeNeedsReconciliation(
      { installed: true, running: true, binaryVersion: "0.1.0-beta.8" },
      "0.1.0-beta.9"
    ),
    true
  );
  assert.equal(
    runtimeNeedsReconciliation(
      { installed: true, running: false },
      "0.1.0-beta.9"
    ),
    true
  );
  assert.equal(
    runtimeNeedsReconciliation(
      { installed: true, running: true, binaryVersion: "0.1.0-beta.9" },
      "0.1.0-beta.9"
    ),
    false
  );
});

test("recovery refuses a runtime path outside its private version directory", async () => {
  const backend = new ElectronUpdateBackend({
    currentVersion: "0.1.0-beta.9",
    packaged: true,
    platform: "darwin",
    arch: "arm64",
    userDataDirectory: "/private/profile",
    binaryPath: () => "/Applications/mdbase connect.app/Contents/Resources/mdbase-connect",
    stateDirectory: () => "/private/profile/state",
    endpoint: () => "/private/profile/connect.sock"
  });
  await assert.rejects(
    backend.recover({
      id: "transaction",
      phase: "recovering",
      target_version: "0.1.0-beta.9",
      previous_version: "0.1.0-beta.8",
      service_installed: true,
      previous_runtime: "/tmp/attacker-controlled",
      started_at: "2026-07-28T00:00:00.000Z"
    }),
    /outside the private update directory/
  );
});
