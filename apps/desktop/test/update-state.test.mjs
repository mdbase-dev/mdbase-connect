import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { UpdateStateStore, parsePersistedState, removeOldRuntimeCopies } = require("../dist/main/update-state.js");

test("state creation is durable and installation identity is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "nested", "state.json");
  const store = new UpdateStateStore(path);
  const first = await store.load();
  const second = await new UpdateStateStore(path).load();
  assert.match(first.installation_id, /^[0-9a-f-]{36}$/);
  assert.equal(second.installation_id, first.installation_id);
  // Windows inherits profile-directory ACLs and reports a synthetic POSIX mode.
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("an old connector-era state file keeps its identity and trust and drops the runtime handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({
    schema_version: 1,
    installation_id: "installation-1",
    highest_trusted_version: "0.1.0-beta.129",
    last_known_good_runtime: { version: "0.1.0-beta.128", path: "/runtimes/beta.128/mdbase" },
    transaction: {
      id: "transaction-1",
      phase: "installing",
      target_version: "0.2.0-beta.1",
      previous_version: "0.1.0-beta.129",
      service_installed: true,
      previous_runtime: "/runtimes/beta.129/mdbase",
      started_at: "2026-07-28T00:00:00.000Z"
    }
  }));
  const store = new UpdateStateStore(path);
  assert.deepEqual(await store.load(), {
    schema_version: 1,
    installation_id: "installation-1",
    highest_trusted_version: "0.1.0-beta.129"
  });
  await store.update((state) => {
    state.daemon_held_back = { version: "0.3.0", reason: "did not become ready" };
  });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.transaction, undefined);
  assert.deepEqual(saved.daemon_held_back, { version: "0.3.0", reason: "did not become ready" });
  assert.deepEqual((await readdir(directory)).filter((name) => name !== "state.json"), []);
});

test("corrupt state is quarantined instead of silently trusted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, '{"schema_version":1,"installation_id":42}');
  const state = await new UpdateStateStore(path).load();
  assert.equal(typeof state.installation_id, "string");
  assert.ok((await readdir(directory)).some((name) => name.startsWith("state.json.invalid-")));
});

test("an invalid held-back daemon version is rejected", () => {
  assert.throws(
    () => parsePersistedState({
      schema_version: 1,
      installation_id: "installation",
      daemon_held_back: { version: "../bad", reason: "x" }
    }),
    /Invalid semantic version/
  );
});

test("removing the old connector's runtime copies keeps the update state", async () => {
  const userData = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const copy = join(userData, "updates", "runtimes", "0.1.0-beta.128");
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, "mdbase"), "old");
  const store = new UpdateStateStore(join(userData, "updates", "state.json"));
  const { installation_id } = await store.load();
  await removeOldRuntimeCopies(userData);
  await removeOldRuntimeCopies(userData);
  assert.deepEqual(await readdir(join(userData, "updates")), ["state.json"]);
  assert.equal((await new UpdateStateStore(store.path).load()).installation_id, installation_id);
});

test("early access, the running version and seen rollouts round-trip and are validated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "state.json");
  const store = new UpdateStateStore(path);
  await store.update((state) => {
    state.early_access = true;
    state.current_version = { version: "0.1.0-beta.9", since: "2026-11-17T06:00:00.000Z" };
    state.rollout_seen = { "v0.1.0-beta.9": "2026-11-17T06:00:00.000Z" };
  });
  const loaded = await new UpdateStateStore(path).load();
  assert.equal(loaded.early_access, true);
  assert.deepEqual(loaded.current_version, { version: "0.1.0-beta.9", since: "2026-11-17T06:00:00.000Z" });
  assert.deepEqual(loaded.rollout_seen, { "v0.1.0-beta.9": "2026-11-17T06:00:00.000Z" });
  const base = { schema_version: 1, installation_id: "installation" };
  assert.throws(() => parsePersistedState({ ...base, early_access: "yes" }));
  assert.throws(() => parsePersistedState({ ...base, current_version: { version: "../bad", since: "2026-11-17T06:00:00.000Z" } }));
  assert.throws(() => parsePersistedState({ ...base, rollout_seen: { "not-a-tag": "2026-11-17T06:00:00.000Z" } }));
  assert.throws(() => parsePersistedState({ ...base, rollout_seen: { "v0.1.0": "later" } }));
});

test("only the newest seen rollouts are kept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const store = new UpdateStateStore(join(directory, "state.json"));
  await store.update((state) => {
    state.rollout_seen = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`v0.1.${index}`, "2026-11-17T06:00:00.000Z"])
    );
  });
  const kept = Object.keys((await store.load()).rollout_seen);
  assert.equal(kept.length, 16);
  assert.ok(kept.includes("v0.1.19"));
  assert.ok(!kept.includes("v0.1.0"));
});
