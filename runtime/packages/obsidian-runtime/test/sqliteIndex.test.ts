import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyError, IndexError, poolNames, SqliteIndex, type SqlValue } from "../src/index/sqliteIndex.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
beforeAll(async () => {
  sqlite3 = await (sqlite3InitModule as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} });
});
const I = (v: number | bigint): SqlValue => ({ kind: "Integer", value: BigInt(v) });
const T = (value: string): SqlValue => ({ kind: "Text", value });

function mem() {
  const db = new sqlite3.oo1.DB(":memory:");
  return { db, index: SqliteIndex.open(sqlite3, db, { pragmas: false }) };
}

describe("SqliteIndex (IndexStorage)", () => {
  it("runs batches with typed values, 64-bit integers and blobs", () => {
    const { index } = mem();
    expect(index.info.opened).toBe("Fresh");
    const r = index.run({
      mode: "Transaction",
      stmts: [
        { sql: "CREATE TABLE t(a INTEGER, b TEXT, c BLOB, d REAL)", params: [] },
        { sql: "INSERT INTO t VALUES (?, ?, ?, ?)", params: [I(2n ** 62n), T("héllo"), { kind: "Blob", value: new Uint8Array([1, 2, 3]) }, { kind: "Real", value: 1.5 }] },
        { sql: "INSERT INTO t VALUES (?, ?, NULL, NULL)", params: [I(-7), T("x")] },
      ],
    });
    expect(r[1]!.changes).toBe(1n);
    expect(r[2]!.lastInsertRowid).toBe(2n);
    const q = index.run({ mode: "Autocommit", stmts: [{ sql: "SELECT a, b, c, d FROM t ORDER BY rowid", params: [] }] });
    expect(q[0]!.columns).toBe(4);
    expect(q[0]!.values).toEqual([I(2n ** 62n), T("héllo"), { kind: "Blob", value: new Uint8Array([1, 2, 3]) }, { kind: "Real", value: 1.5 }, I(-7), T("x"), { kind: "Null" }, { kind: "Null" }]);
  });

  it("rolls the whole transaction back on a failing statement and names it", () => {
    const { index } = mem();
    index.run({ mode: "Transaction", stmts: [{ sql: "CREATE TABLE u(k INTEGER PRIMARY KEY)", params: [] }] });
    let err: IndexError | null = null;
    try {
      index.run({
        mode: "Transaction",
        stmts: [
          { sql: "INSERT INTO u VALUES (1)", params: [] },
          { sql: "INSERT INTO u VALUES (1)", params: [] },
        ],
      });
    } catch (e) {
      err = e as IndexError;
    }
    expect(err).toMatchObject({ kind: "Sql", stmt: 1 });
    expect(index.run({ mode: "Autocommit", stmts: [{ sql: "SELECT count(*) FROM u", params: [] }] })[0]!.values).toEqual([I(0)]);
  });

  it("reuses prepared statements across calls", () => {
    const { index, db } = mem();
    index.run({ mode: "Transaction", stmts: [{ sql: "CREATE TABLE v(x)", params: [] }] });
    for (let i = 0; i < 50; i++) index.run({ mode: "Transaction", stmts: [{ sql: "INSERT INTO v VALUES (?)", params: [I(i)] }] });
    expect(index.run({ mode: "Autocommit", stmts: [{ sql: "SELECT sum(x) FROM v", params: [] }] })[0]!.values).toEqual([I(1225)]);
    expect(db.selectValue("SELECT count(*) FROM v")).toBe(50);
  });

  it("detects an unclean shutdown and a clean one", () => {
    const db = new sqlite3.oo1.DB(":memory:");
    SqliteIndex.open(sqlite3, db, { pragmas: false }); // never closed
    expect(SqliteIndex.open(sqlite3, db, { pragmas: false }).info.opened).toBe("Unclean");
    db.exec("UPDATE _mdbn_host SET v = 1 WHERE k = 'clean'"); // what close() writes
    expect(SqliteIndex.open(sqlite3, db, { pragmas: false }).info.opened).toBe("Existing");
  });

  it("classifies errors the store branches on", () => {
    expect(classifyError(Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" })).kind).toBe("Full");
    expect(classifyError(Object.assign(new Error("x"), { resultCode: 11 })).kind).toBe("Corrupt");
    expect(classifyError(new Error("database disk image is malformed")).kind).toBe("Corrupt");
    expect(classifyError(Object.assign(new Error("in use"), { name: "NoModificationAllowedError" })).kind).toBe("Busy");
    expect(classifyError(Object.assign(new Error("x"), { resultCode: 13 })).kind).toBe("Full");
  });

  it("scopes pool names by collection id", () => {
    expect(poolNames("0F8E3C3A-7D2B-4C55-9D7E-0B6F3D2A1C11")).toEqual({ vfs: "mdbase-0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11", directory: ".mdbase-index-0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11" });
    expect(() => poolNames("../x")).toThrow();
  });
});
