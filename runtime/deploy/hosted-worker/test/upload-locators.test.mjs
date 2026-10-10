import test from "node:test";
import assert from "node:assert/strict";
import { UploadLocators } from "../src/upload-locators.ts";
function boundary() {
  return { transfer: new Uint8Array(16), grant: new Uint8Array(16), clientPk: new Uint8Array(32),
    account: new Uint8Array(16), epoch: 1, attachment: new Uint8Array(32), cipherHash: new Uint8Array(32),
    sealedBytes: 4096, committedChunks: 1, expiresAtMs: 1100 };
}
function fixture(clock = () => 1000) {
  const calls = [];
  const storage = { sql: { exec(sql) { calls.push(sql);throw new Error("data SQL must not run"); } },
    transactionSync() { throw new Error("transaction must not run"); } };
  storage.sql.exec = (sql) => { calls.push(sql);if (sql.startsWith("CREATE TABLE")) return {};
    throw new Error("data SQL must not run"); };
  const db = new UploadLocators(storage, new Uint8Array(16), clock);calls.length = 0;
  return { db, calls };
}
test("missing current native owner/boundary never reads or writes data SQL", () => {
  const { db, calls } = fixture();
  assert.throws(() => db.put(() => null));assert.throws(() => db.get(() => null));assert.throws(() => db.remove(() => null));
  assert.deepEqual(calls, []);
});
test("typed metadata bounds precede SQL, with no arbitrary BLOB/checkpoint fallback", () => {
  for (const change of [{ epoch: 0 }, { epoch: 1.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { committedChunks: 129 }, { committedChunks: -1 }, { sealedBytes: 65537 }, { sealedBytes: 0 },
    { expiresAtMs: 1000 }, { expiresAtMs: 1000 + 86_400_001 }, { transfer: new Uint8Array(17) },
    { cipherHash: new Uint8Array(8 << 20) }, { attachment: "plaintext checkpoint" },
    { grant: Promise.resolve(new Uint8Array(16)) }]) {
    const { db, calls } = fixture();assert.throws(() => db.put(() => ({ ...boundary(), ...change })));
    assert.deepEqual(calls, []);
  }
});
test("invalid host clocks refuse before data SQL", () => {
  for (const clock of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { db, calls } = fixture(() => clock);assert.throws(() => db.put(boundary));assert.deepEqual(calls, []);
  }
});
test("SQL transaction outcome errors propagate; no success or recovery/adoption", () => {
  let attempts = 0;
  const db = new UploadLocators({ sql: { exec() {} }, transactionSync() {
    attempts++;throw new Error("SQL boundary outcome unknown");
  } }, new Uint8Array(16), () => 1000);
  assert.throws(() => db.put(boundary), /SQL boundary outcome unknown/);assert.equal(attempts, 1);
});
