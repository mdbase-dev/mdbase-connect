import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationRunRequest, newRun, storageRunStore } from "../src/migration-run.ts";
import { migrationOperatorRequest, migrationOperatorBody } from "../src/migration-operator.ts";

const collection = "10000000-0000-4000-8000-000000000001";
const hold = "20000000-0000-4000-8000-000000000002";
const token = "public-unit-token".repeat(3);
const request = (body, auth = true) => new Request("https://worker.test/internal/v1/migration/run", {
  method: "POST", headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

test("run pause intent is optional only for old callers; exact bool/keys/auth/1024-byte bound", async () => {
  for (const mode of [undefined, false, true]) {
    assert.deepEqual(await migrationRunRequest(request({ collection, backup_hold: hold,
      ...(mode === undefined ? {} : { stop_before_flip: mode }) }), token),
    { collection, backupHold: hold, pauseBeforeCutover: mode === true });
  }
  for (const body of [{ collection, backup_hold: hold, stop_before_flip: "true" },
    { collection, backup_hold: hold, stop_before_flip: null },
    { collection, backup_hold: hold, stop_before_flip: true, resumed_run_sequence: 1 },
    JSON.stringify({ collection, backup_hold: hold, stop_before_flip: true }) + " ".repeat(1024)]) {
    assert.equal((await migrationRunRequest(request(body), token)).status, 400);
  }
  assert.equal((await migrationRunRequest(request({ collection, backup_hold: hold }, false), token)).status, 401);
});

test("resume takes only a positive safe immutable run sequence, never action sequence/outcome/ACK", async () => {
  const body = { collection, operation: "resume", expected_run_sequence: 3 };
  const parsed = await migrationOperatorRequest(request(body), token);
  assert.deepEqual(parsed, { collection, operation: "resume", expectedSequence: 3 });
  assert.deepEqual(migrationOperatorBody(parsed), body);
  for (const invalid of [{ collection, operation: "resume", expected_action_sequence: 3 },
    { ...body, expected_run_sequence: 0 }, { ...body, expected_run_sequence: 1.5 },
    { ...body, expected_run_sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...body, ack: true }]) {
    assert.equal((await migrationOperatorRequest(request(invalid), token)).status, 400);
  }
  assert.equal((await migrationOperatorRequest(request(body, false), token)).status, 401);
});

test("old v1 jobs retain normal mode; malformed persisted pause/resume intent fails closed", async () => {
  const original = newRun(collection, hold, 1);
  delete original.pauseBeforeCutover; delete original.resumeRunSequence;
  const load = value => storageRunStore({ get: async () => value, put: async () => {}, sync: async () => {} }).load();
  const old = await load(original);
  assert.equal(old.pauseBeforeCutover, false); assert.equal(old.resumeRunSequence, null);
  for (const value of [{ ...old, pauseBeforeCutover: "true" }, { ...old, resumeRunSequence: 1 },
    { ...old, pauseBeforeCutover: true, resumeRunSequence: -1 }, { ...old, v: 2 }]) {
    await assert.rejects(load(value), /migration_run_invalid/);
  }
});
