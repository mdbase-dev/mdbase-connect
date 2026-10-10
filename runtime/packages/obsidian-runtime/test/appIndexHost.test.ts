import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_INDEX_LIMITS, AppBinaryIndexHost, AppSqliteIndex, appSqlHost } from "../src/index/appSqliteIndex.js";
import { IndexError, SqliteIndex, type Batch, type SqlValue } from "../src/index/sqliteIndex.js";

// Real sqlite-wasm in memory; no OPFS or power-loss claim.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
beforeAll(async () => { sqlite3 = await (sqlite3InitModule as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} }); });
afterEach(() => vi.restoreAllMocks());
const MAGIC = new TextEncoder().encode("MDBIDX\0\x01");
const text = new TextEncoder();
const i64 = (n: bigint, unsigned = false) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); if (unsigned) v.setBigUint64(0, n, true); else v.setBigInt64(0, n, true); return [...b]; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return [...b]; };
const data = (b: Uint8Array) => [...u32(b.length), ...b];
function value(v: SqlValue): number[] {
  switch (v.kind) {
    case "Null": return [0];
    case "Integer": return [1, ...i64(v.value)];
    case "Real": { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v.value, true); return [2, ...b]; }
    case "Text": return [3, ...data(text.encode(v.value))];
    case "Blob": return [4, ...data(v.value)];
  }
}
function request(stmts: Batch["stmts"], mode: Batch["mode"] = "Transaction"): Uint8Array {
  return Uint8Array.from([...MAGIC, 0, mode === "Transaction" ? 0 : 1, ...u32(stmts.length),
    ...stmts.flatMap((s) => [...data(text.encode(s.sql)), ...u32(s.params.length), ...s.params.flatMap(value)])]);
}
const select = (sql = "SELECT 1", params: SqlValue[] = []) => request([{ sql, params }]);
function memory() {
  const db = new sqlite3.oo1.DB(":memory:");
  const inner = SqliteIndex.open(sqlite3, db, { pragmas: false });
  const index = new AppSqliteIndex(inner);
  return { db, inner, index, host: new AppBinaryIndexHost(index) };
}
function expectError(bytes: Uint8Array, tag?: number) {
  expect([...bytes.slice(0, 9)]).toEqual([...MAGIC, 3]);
  if (tag !== undefined) expect(bytes[9]).toBe(tag);
  expect(new TextDecoder().decode(bytes)).toContain("reopen and reconcile");
}

describe("app binary index (file ABI v1)", () => {
  it("pins an exact native-compatible result, including i64/u64 and metadata", () => {
    const { host, index } = memory();
    // Native index_codec Results: columns u32, changes u64, rowid i64, count u32, values.
    // Opening inserts the host flag in a WITHOUT ROWID table: changes=1, rowid=0.
    expect(host.run(select())).toEqual(Uint8Array.from([...MAGIC, 2, ...u32(1), ...u32(1), ...i64(1n, true), ...i64(0n), ...u32(1), 1, ...i64(1n)]));
    index.close();
  });
  it("preserves tags, extreme INTEGERs, integral REAL, negative zero, UTF-8/BOM and BLOB", () => {
    const { host, inner, index } = memory();
    const vals: SqlValue[] = [
      { kind: "Null" }, { kind: "Integer", value: -(1n << 63n) }, { kind: "Integer", value: (1n << 63n) - 1n },
      { kind: "Real", value: 2 }, { kind: "Real", value: -0 }, { kind: "Text", value: "\ufeff日é" }, { kind: "Blob", value: Uint8Array.of(0, 255) },
    ];
    const run = vi.spyOn(inner, "run").mockImplementation((batch) => [{ columns: vals.length, values: [...batch.stmts[0]!.params], changes: (1n << 64n) - 1n, lastInsertRowid: -(1n << 63n) }]);
    const reply = host.run(select("SELECT ?,?,?,?,?,?,?", vals));
    expect(run.mock.calls[0]![0].stmts[0]!.params).toEqual(vals);
    expect(Object.is((run.mock.calls[0]![0].stmts[0]!.params[4] as { value: number }).value, -0)).toBe(true);
    expect(reply).toEqual(Uint8Array.from([...MAGIC, 2, ...u32(1), ...u32(vals.length), ...i64((1n << 64n) - 1n, true), ...i64(-(1n << 63n)), ...u32(vals.length), ...vals.flatMap(value)]));
    index.close();
  });
  it("uses actual SQLite types, not JS integer/REAL inference", () => {
    const { host, index } = memory();
    const vals: SqlValue[] = [{ kind: "Integer", value: 9007199254740993n }, { kind: "Real", value: 2 }, { kind: "Blob", value: Uint8Array.of(1, 2) }];
    const reply = host.run(select("SELECT ?,CAST(? AS REAL),?", vals));
    expect(reply.slice(37)).toEqual(Uint8Array.from(vals.flatMap(value)));
    index.close();
  });
  it("validates the complete batch before the first SQL effect, and fences malformed input", () => {
    const { host, db, inner, index } = memory();
    const run = vi.spyOn(inner, "run");
    const b = request([{ sql: "CREATE TABLE should_not_exist(id)", params: [] }, { sql: "SELECT ?", params: [{ kind: "Null" }] }]);
    b[b.length - 1] = 255;
    expectError(host.run(b), 4);
    expect(run).not.toHaveBeenCalled();
    expect(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name='should_not_exist'")).toBe(0);
    expect(index.needsRecovery).toBe(true);
    expectError(host.run(select()), 4);
    expect(run).not.toHaveBeenCalled();
    const exec = vi.spyOn(db, "exec");
    index.close();
    expect(exec.mock.calls.some(([sql]) => String(sql).includes("('clean', 1)"))).toBe(false);
  });
  it("refuses every truncation and trailing bytes before any SQL", () => {
    const b = select("SELECT ?", [{ kind: "Text", value: "é" }]);
    for (let end = 0; end < b.length; end++) {
      const { host, inner, index } = memory();
      const run = vi.spyOn(inner, "run");
      expectError(host.run(b.subarray(0, end)));
      expect(run).not.toHaveBeenCalled(); index.close();
    }
    const { host, inner, index } = memory();
    const run = vi.spyOn(inner, "run");
    expectError(host.run(Uint8Array.from([...b, 0])), 4);
    expect(run).not.toHaveBeenCalled(); index.close();
  });
  it.each([
    Uint8Array.from([...MAGIC, 0, 2, ...u32(0)]),
    Uint8Array.from([...MAGIC, 0, 0, ...u32(0xffffffff)]),
    Uint8Array.from([...MAGIC, 0, 0, ...u32(1), ...u32(0), ...u32(101)]),
    Uint8Array.from([...MAGIC, 0, 0, ...u32(1), ...u32(100 * 1024 + 1)]),
    Uint8Array.from([...MAGIC, 0, 0, ...u32(1), ...u32(1), 255, ...u32(0)]),
    select("SELECT ?", [{ kind: "Real", value: Infinity }]),
    select("SELECT ?", [{ kind: "Real", value: NaN }]),
    new Uint8Array(APP_INDEX_LIMITS.maxBytes + 1),
  ])("rejects invalid framing/counts/values before dispatch", (bytes) => {
    const { host, inner, index } = memory();
    const run = vi.spyOn(inner, "run");
    expectError(host.run(bytes)); expect(run).not.toHaveBeenCalled(); index.close();
  });
  it("reset golden request never erases tentative work", () => {
    const { host, db, index } = memory();
    db.exec("CREATE TABLE pending(id); INSERT INTO pending VALUES (1)");
    expectError(host.run(new TextEncoder().encode("MDBIDX\0\x01\x01")), 4);
    expect(db.selectValue("SELECT count(*) FROM pending")).toBe(1);
    expect(index.needsRecovery).toBe(true); index.close();
  });
  it("caps rows while iterating and rolls a transaction back (but still fences)", () => {
    const { host, db, index } = memory();
    db.exec("CREATE TABLE pending(id)");
    const reply = host.run(request([{ sql: "INSERT INTO pending VALUES (1)", params: [] },
      { sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4097) SELECT x FROM n", params: [] }]));
    expectError(reply, 2);
    expect(db.selectValue("SELECT count(*) FROM pending")).toBe(0);
    expect(index.needsRecovery).toBe(true); index.close();
  });
  it("checks native BLOB byte size before copying an oversized value to JS", () => {
    const { host, db, index } = memory();
    const original = db.prepare.bind(db);
    const getBlob = vi.fn();
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const st = original(sql);
      st.getBlob = getBlob;
      return st;
    });
    expectError(host.run(select(`SELECT zeroblob(${APP_INDEX_LIMITS.maxBytes})`)), 2);
    expect(getBlob).not.toHaveBeenCalled(); index.close();
  });
  it("caps cumulative values, columns and bytes during actual SQLite iteration", () => {
    for (const sql of [
      `SELECT ${Array(101).fill("1").join(",")}`,
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4096) SELECT ${Array(33).fill("x").join(",")} FROM n`,
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT zeroblob(5000) FROM n",
    ]) {
      const { host, index } = memory();
      expectError(host.run(select(sql)), 2); expect(index.needsRecovery).toBe(true); index.close();
    }
  });
  it("caps cumulative request values before any SQL", () => {
    const { host, inner, index } = memory();
    const run = vi.spyOn(inner, "run");
    const stmts = Array(1311).fill({ sql: "SELECT 1", params: Array(100).fill({ kind: "Null" }) });
    expectError(host.run(request(stmts)), 2); expect(run).not.toHaveBeenCalled(); index.close();
  });
  it("refuses unsafe integer evidence rather than silently rounding", () => {
    const { host, index } = memory();
    vi.spyOn(sqlite3.capi, "sqlite3_column_int64").mockReturnValue(9007199254740992);
    expectError(host.run(select()), 4); expect(index.needsRecovery).toBe(true); index.close();
  });
  it("does not leak backend SQL/secrets in error replies", () => {
    const { host, inner, index } = memory();
    vi.spyOn(inner, "run").mockImplementation(() => { throw new IndexError("Busy", "private key/path/SQL", 0); });
    const reply = host.run(select());
    expectError(reply, 3); expect(reply[10]).toBe(1);
    expect(new TextDecoder().decode(reply)).not.toContain("private"); index.close();
  });
  it.each([
    [], [{ columns: 2, values: [{ kind: "Null" }], changes: 0n, lastInsertRowid: 0n }],
    [{ columns: 0, values: [{ kind: "Null" }], changes: 0n, lastInsertRowid: 0n }],
    [{ columns: 1, values: [{ kind: "Integer", value: 1n << 63n }], changes: 0n, lastInsertRowid: 0n }],
    [{ columns: 1, values: [{ kind: "Real", value: NaN }], changes: 0n, lastInsertRowid: 0n }],
    [{ columns: 0, values: [], changes: -1n, lastInsertRowid: 0n }],
  ].map((results) => ({ results })))("fences malformed backend result shapes and numeric ranges", ({ results }) => {
    const { host, inner, index } = memory();
    vi.spyOn(inner, "run").mockReturnValue(results as never);
    expectError(host.run(select())); expect(index.needsRecovery).toBe(true); index.close();
  });
});

describe("same-Worker WASM import memory ownership", () => {
  it("copies borrowed input, survives memory grow, and packs the owned reply", () => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const bytes = select();
    new Uint8Array(wasm.buffer, 8, bytes.length).set(bytes);
    const alloc = vi.fn((length: number) => { wasm.grow(1); new Uint8Array(wasm.buffer, 8, bytes.length).fill(255); expect(length).toBeGreaterThan(0); return 65536; });
    const packed = appSqlHost(host, () => ({ memory: wasm, alloc }))(8, bytes.length);
    expect(Number(packed >> 32n)).toBe(65536);
    const reply = new Uint8Array(wasm.buffer, 65536, Number(packed & 0xffffffffn));
    expect(reply[8]).toBe(2); expect(alloc).toHaveBeenCalledOnce(); index.close();
  });
  it.each([[-1, 1], [0, -1], [65535, 2], [0.5, 2], [0, 0xffffffff], [0xffffffff + 1, 0]])("invalid pointer/length throws and fences", (ptr, len) => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const alloc = vi.fn();
    expect(() => appSqlHost(host, () => ({ memory: wasm, alloc }))(ptr, len)).toThrow();
    expect(alloc).not.toHaveBeenCalled(); expect(index.needsRecovery).toBe(true); index.close();
  });
  it("allocation failure fails stop, without serving or marking clean", () => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const bytes = select(); new Uint8Array(wasm.buffer, 8, bytes.length).set(bytes);
    expect(() => appSqlHost(host, () => ({ memory: wasm, alloc: () => 0 }))(8, bytes.length)).toThrow();
    expect(index.needsRecovery).toBe(true); index.close();
  });
  it.each([8, 65535, -1, 1.5])("refuses overlapping or invalid allocator output: %d", (out) => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const bytes = select(); new Uint8Array(wasm.buffer, 8, bytes.length).set(bytes);
    expect(() => appSqlHost(host, () => ({ memory: wasm, alloc: () => out }))(8, bytes.length)).toThrow();
    expect(index.needsRecovery).toBe(true); index.close();
  });
  it("allocator cannot swallow a recursive entry failure and keep serving", () => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const bytes = select(); new Uint8Array(wasm.buffer, 8, bytes.length).set(bytes);
    const call: (p: number, n: number) => bigint = appSqlHost(host, () => ({ memory: wasm, alloc: () => {
      try { call(8, bytes.length); } catch { /* malicious/buggy allocator swallows the trap */ }
      return 1024;
    } }));
    expect(() => call(8, bytes.length)).toThrow(); expect(index.needsRecovery).toBe(true); index.close();
  });
  it("recursive allocator entry fences both calls", () => {
    const { host, index } = memory();
    const wasm = new WebAssembly.Memory({ initial: 1 });
    const bytes = select(); new Uint8Array(wasm.buffer, 8, bytes.length).set(bytes);
    const call: (p: number, n: number) => bigint = appSqlHost(host, () => ({ memory: wasm, alloc: () => { call(8, bytes.length); return 1024; } }));
    expect(() => call(8, bytes.length)).toThrow(); expect(index.needsRecovery).toBe(true); index.close();
  });
});
