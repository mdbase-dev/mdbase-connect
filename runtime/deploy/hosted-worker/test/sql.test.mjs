// Unit tests of the DO host side of file's binary index ABI, over a fake storage.
// Run: node --experimental-transform-types --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { runIndex } from "../src/sql.ts";

const MAGIC = [0x4d, 0x44, 0x42, 0x49, 0x44, 0x58, 0x00, 0x01];

function req(stmts, mode = 0) {
  const out = [...MAGIC, 0, mode];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); out.push(...b); };
  u32(stmts.length);
  for (const [sql, params] of stmts) {
    const s = Buffer.from(sql); u32(s.length); out.push(...s);
    u32(params.length);
    for (const p of params) {
      if (p === null) out.push(0);
      else if (typeof p === "bigint") { out.push(1); const b = Buffer.alloc(8); b.writeBigInt64LE(p); out.push(...b); }
      else if (typeof p === "number") { out.push(2); const b = Buffer.alloc(8); b.writeDoubleLE(p); out.push(...b); }
      else { out.push(3); const t = Buffer.from(p); u32(t.length); out.push(...t); }
    }
  }
  return Uint8Array.from(out);
}

function storage(rows, info = { c: 0, r: 0 }) {
  let execs = 0;
  return {
    execs: () => execs,
    transactionSync: (f) => f(),
    sql: {
      exec(sql) {
        execs++;
        if (sql.startsWith("SELECT changes()")) return { one: () => info };
        return { columnNames: rows[0] ? rows[0].map((_, i) => `c${i}`) : [], *raw() { yield* rows; } };
      },
    },
  };
}

const op = (b) => b[8];
const errKind = (b) => b[9];

test("results are typed and well formed", () => {
  const out = runIndex(storage([[1, "a"], [2, null]]), req([["SELECT", [5n, "x"]]]));
  assert.equal(op(out), 2);
});

test("a REAL parameter or unsafe integer is refused before any SQL", () => {
  const s = storage([[1]]);
  assert.equal(op(runIndex(s, req([["SELECT", [1.5]]]))), 3);
  assert.equal(op(runIndex(s, req([["SELECT", [2n ** 60n]]]))), 3);
  assert.equal(s.execs(), 0);
});

test("an oversized result is a typed Full error, not an allocation of the whole cursor", () => {
  const big = "x".repeat(1 << 20);
  const rows = Array.from({ length: 6 }, () => [big]);
  const out = runIndex(storage(rows), req([["SELECT", []]]));
  assert.equal(op(out), 3);
  assert.equal(errKind(out), 2);
});

test("many NULL values hit the value budget", () => {
  const rows = Array.from({ length: 4000 }, () => Array(40).fill(null));
  const out = runIndex(storage(rows), req([["SELECT", []]]));
  assert.equal(op(out), 3);
  assert.equal(errKind(out), 2);
});

test("unsafe changes()/rowid are refused", () => {
  const out = runIndex(storage([], { c: 0, r: 2 ** 60 }), req([["UPDATE", []]]));
  assert.equal(op(out), 3);
});

test("a fractional result (unexpected REAL) is refused", () => {
  assert.equal(op(runIndex(storage([[0.5]]), req([["SELECT", []]]))), 3);
});

test("bad magic, trailing bytes and too many statements are refused", () => {
  const bad = req([["SELECT", []]]); bad[0] = 0;
  assert.equal(op(runIndex(storage([]), bad)), 3);
  const trailing = Uint8Array.from([...req([["SELECT", []]]), 0]);
  assert.equal(op(runIndex(storage([]), trailing)), 3);
  const many = [...MAGIC, 0, 0, ...(() => { const b = Buffer.alloc(4); b.writeUInt32LE(20000); return b; })()];
  assert.equal(op(runIndex(storage([]), Uint8Array.from(many))), 3);
});
