import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const require = createRequire(import.meta.url);
const { classifyRoleMarker, readRoleMarker, readTakeoverRecord, detectTakeover,
  registeredFoldersFromRegistry, newDaemonStateDirectory } = require("../dist/main/takeover-handoff.js");
const uuid = "12345678-1234-1234-1234-123456789abc";
const claim = { version: 2, role: "replica", collection: uuid, replica_id: uuid, runtime: "mdbase-next" };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-bridge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("marker classifier accepts exactly the legacy and takeover formats", () => {
  assert.deepEqual(classifyRoleMarker(JSON.stringify(claim)), { kind: "claimed", runtime: "mdbase-next" });
  assert.deepEqual(classifyRoleMarker(JSON.stringify({ ...claim, runtime: null })), { kind: "claimed", runtime: null });
  assert.deepEqual(classifyRoleMarker(JSON.stringify({ version: 1, role: "mirror", collection_id: uuid })), { kind: "mirror" });
  for (const value of [null, [], {}, { ...claim, version: 3 }, { ...claim, role: "mirror" },
    { ...claim, collection_id: null }, { ...claim, collection: "invalid" }, { ...claim, replica_id: "invalid" }]) {
    assert.deepEqual(classifyRoleMarker(JSON.stringify(value)), { kind: "unreadable" });
  }
  assert.deepEqual(classifyRoleMarker("{"), { kind: "unreadable" });
});

test("role marker is absent, readable, or unreadable without following links", { skip: process.platform === "win32" }, async (t) => {
  const folder = await fixture(t);
  assert.deepEqual(await readRoleMarker(folder), { kind: "absent" });
  await mkdir(join(folder, ".mdbase"));
  const path = join(folder, ".mdbase", "connect-role.json");
  await writeFile(path, JSON.stringify(claim));
  assert.equal((await readRoleMarker(folder)).kind, "claimed");
  await rm(path);
  await symlink(join(folder, "missing"), path);
  assert.equal((await readRoleMarker(folder)).kind, "unreadable");
});

test("record handles matching profiles, rollback, unknown schema/state, and malformed records", async (t) => {
  const directory = await fixture(t);
  const old = join(directory, "old");
  const path = join(directory, "takeover.json");
  assert.equal(await readTakeoverRecord(directory, old), null);
  for (const state of ["started", "complete", "postponed", "rolled_back"]) {
    await writeFile(path, JSON.stringify({ schema_version: 1, state, old_state_dir: old }), { mode: 0o600 });
    assert.equal((await readTakeoverRecord(directory, old)).state, state);
    assert.equal(await readTakeoverRecord(directory, join(directory, "other")), null);
  }
  for (const record of [ { schema_version: 2, state: "complete" }, { schema_version: 1, state: "future" } ]) {
    await writeFile(path, JSON.stringify({ ...record, old_state_dir: old }));
    assert.equal((await readTakeoverRecord(directory, old)).state, "started");
  }
  for (const value of ["{", "null", "[]", JSON.stringify({ schema_version: 1, state: "started" })]) {
    await writeFile(path, value);
    await assert.rejects(readTakeoverRecord(directory, old));
  }
});

test("record refuses links, writable records, wrong owner, and linked state directories", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t);
  const old = join(directory, "old");
  const path = join(directory, "takeover.json");
  await writeFile(path, JSON.stringify({ schema_version: 1, state: "started", old_state_dir: old }), { mode: 0o600 });
  await assert.rejects(readTakeoverRecord(directory, old, "linux", process.getuid() + 1), /another user/);
  await chmod(path, 0o664);
  await assert.rejects(readTakeoverRecord(directory, old), /writable/);
  await rm(path);
  await symlink(join(directory, "missing"), path);
  await assert.rejects(readTakeoverRecord(directory, old), /ordinary file/);
  const linked = join(directory, "linked");
  await symlink(directory, linked);
  await assert.rejects(readTakeoverRecord(linked, old), /ordinary directory/);
});

test("claims are a second signal regardless of absent, rolled-back or postponed records", async () => {
  for (const state of [null, "rolled_back", "postponed", "started", "complete"]) {
    for (const claimed of [false, true]) {
      const result = await detectTakeover({
        takeoverRecord: async () => state ? { state } : null,
        registeredFolders: async () => ["a", "b"],
        readMarker: async (folder) => ({ kind: claimed && folder === "b" ? "claimed" : "mirror" })
      });
      const recorded = state === "rolled_back" || state === null ? "none" : state;
      assert.deepEqual(result, {
        state: claimed && ["none", "postponed"].includes(recorded) ? "started" : recorded,
        claimedFolders: claimed ? ["b"] : []
      });
    }
  }
  await assert.rejects(detectTakeover({ takeoverRecord: async () => { throw new Error("unreadable"); } }), /unreadable/);
});

test("registered folders use the real registry read-only and propagate corruption", async (t) => {
  const directory = await fixture(t);
  assert.deepEqual(await registeredFoldersFromRegistry(directory), []);
  const path = join(directory, "connector.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE collections (path TEXT); INSERT INTO collections VALUES ('/one'), ('/two'), (NULL)");
  db.close();
  assert.deepEqual(await registeredFoldersFromRegistry(directory), ["/one", "/two"]);
  await writeFile(path, "corrupt");
  await assert.rejects(registeredFoldersFromRegistry(directory));
});

test("installed profile paths are disjoint from Connect state", () => {
  assert.equal(newDaemonStateDirectory("linux", "/home/user"), join("/home/user", ".local", "state", "mdbase"));
  assert.equal(newDaemonStateDirectory("darwin", "/Users/user"), join("/Users/user", "Library", "Application Support", "mdbase"));
  assert.equal(newDaemonStateDirectory("win32", "/user", { LOCALAPPDATA: "/local" }), join("/local", "mdbase", "state"));
  assert.throws(() => newDaemonStateDirectory("win32", "/user", {}), /LOCALAPPDATA/);
});
