import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { UpdateStateStore, parsePersistedState } = require("../dist/main/update-state.js");

test("state creation is durable and installation identity is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "nested", "state.json");
  const store = new UpdateStateStore(path);
  const first = await store.load();
  const second = await new UpdateStateStore(path).load();
  assert.match(first.installation_id, /^[0-9a-f-]{36}$/);
  assert.equal(second.installation_id, first.installation_id);
  const mode = (await import("node:fs/promises")).stat(path).then((value) => value.mode & 0o777);
  assert.equal(await mode, 0o600);
});

test("state writes are atomic and preserve valid transactions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "state.json");
  const store = new UpdateStateStore(path);
  await store.load();
  await store.update((state) => {
    state.highest_trusted_version = "0.1.0-beta.9";
    state.transaction = {
      id: "transaction-1",
      phase: "prepared",
      target_version: "0.1.0-beta.9",
      previous_version: "0.1.0-beta.8",
      service_installed: true,
      previous_runtime: "/safe/runtime",
      started_at: "2026-07-28T00:00:00.000Z"
    };
  });
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.equal(parsed.transaction.phase, "prepared");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.includes(".tmp-")),
    []
  );
});

test("corrupt state is quarantined instead of silently trusted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-state-"));
  const path = join(directory, "state.json");
  await writeFile(path, '{"schema_version":1,"installation_id":42}');
  const state = await new UpdateStateStore(path).load();
  assert.equal(typeof state.installation_id, "string");
  assert.ok((await readdir(directory)).some((name) => name.startsWith("state.json.invalid-")));
});

test("invalid transaction versions and paths are rejected", () => {
  assert.throws(
    () =>
      parsePersistedState({
        schema_version: 1,
        installation_id: "installation",
        transaction: {
          id: "transaction",
          phase: "installing",
          target_version: "../bad",
          previous_version: "0.1.0-beta.8",
          service_installed: true,
          previous_runtime: "/runtime",
          started_at: "2026-07-28T00:00:00Z"
        }
      }),
    /Invalid semantic version/
  );
});
