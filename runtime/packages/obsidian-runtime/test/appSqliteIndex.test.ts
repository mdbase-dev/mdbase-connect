import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppSqliteIndex, appPoolNames, openAppSahpoolIndex } from "../src/index/appSqliteIndex.js";
import { SqliteIndex } from "../src/index/sqliteIndex.js";

// Real sqlite-wasm in memory for SQL semantics; fake pools do NOT qualify OPFS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite3: any;
beforeAll(async () => { sqlite3 = await (sqlite3InitModule as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} }); });
afterEach(() => vi.restoreAllMocks());
const scope = { account: "00000000-0000-4000-8000-000000000001", installation: "00000000-0000-4000-8000-000000000002", collection: "00000000-0000-4000-8000-000000000003" };
function memory() {
  const db = new sqlite3.oo1.DB(":memory:");
  const inner = SqliteIndex.open(sqlite3, db, { pragmas: false });
  return { db, inner, index: new AppSqliteIndex(inner) };
}

describe("app SQLite namespaces and fences", () => {
  it("scopes by account, installation and collection, distinct from Obsidian", () => {
    const n = appPoolNames(scope);
    expect(n.vfs).toBe(`mdbase-app-${scope.account}-${scope.installation}-${scope.collection}`);
    expect(n.directory).toBe(`.${n.vfs}`);
    expect(appPoolNames({ ...scope, account: scope.account.toUpperCase() })).toEqual(n);
    for (const key of ["account", "installation", "collection"] as const) {
      expect(appPoolNames({ ...scope, [key]: "00000000-0000-4000-8000-000000000009" })).not.toEqual(n);
      expect(() => appPoolNames({ ...scope, [key]: "../other" })).toThrow("invalid app storage scope");
    }
  });
  it("runs the shared SQL adapter and remains Disposable", () => {
    const { db, index } = memory();
    expect(index.info.durability).toBe("Disposable");
    index.run({ mode: "Transaction", stmts: [{ sql: "CREATE TABLE edits(id INTEGER PRIMARY KEY, bytes BLOB)", params: [] }, { sql: "INSERT INTO edits VALUES (?, ?)", params: [{ kind: "Integer", value: 1n }, { kind: "Blob", value: new Uint8Array([1, 2, 3]) }] }] });
    expect(db.selectValue("SELECT count(*) FROM edits")).toBe(1);
    expect(index.needsRecovery).toBe(false);
    index.close();
    expect(() => index.run({ mode: "Autocommit", stmts: [] })).toThrow("fenced or closed");
  });
  it("refuses reset without touching pending data", () => {
    const { db, index } = memory();
    db.exec("CREATE TABLE pending(id); INSERT INTO pending VALUES (1)");
    expect(() => index.reset()).toThrow("automatic wipe refused");
    expect(db.selectValue("SELECT count(*) FROM pending")).toBe(1);
    index.close();
  });
  it("fences even a rolled-back failing statement, preserving state", () => {
    const { db, index } = memory();
    db.exec("CREATE TABLE pending(id INTEGER PRIMARY KEY)");
    expect(() => index.run({ mode: "Transaction", stmts: [{ sql: "INSERT INTO pending VALUES (1)", params: [] }, { sql: "INSERT INTO pending VALUES (1)", params: [] }] })).toThrow("reopen and reconcile");
    expect(db.selectValue("SELECT count(*) FROM pending")).toBe(0);
    expect(index.needsRecovery).toBe(true);
    expect(() => index.run({ mode: "Autocommit", stmts: [{ sql: "SELECT 1", params: [] }] })).toThrow("fenced or closed");
    const exec = vi.spyOn(db, "exec");
    index.close();
    expect(exec.mock.calls.some(([sql]) => String(sql).includes("('clean', 1)"))).toBe(false);
  });
  it("COMMIT may apply before an error; never retry or claim rollback", () => {
    const { db, index } = memory();
    db.exec("CREATE TABLE pending(id INTEGER PRIMARY KEY)");
    const original = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      const result = original(sql);
      if (sql === "COMMIT") throw new Error("private storage detail");
      return result;
    });
    expect(() => index.run({ mode: "Transaction", stmts: [{ sql: "INSERT INTO pending VALUES (1)", params: [] }] })).toThrow("app SQLite operation failed; reopen and reconcile");
    expect(db.selectValue("SELECT count(*) FROM pending")).toBe(1);
    expect(db.selectValue("SELECT v FROM _mdbn_host WHERE k='clean'")).toBe(0);
    expect(index.needsRecovery).toBe(true);
    expect(() => index.run({ mode: "Transaction", stmts: [] })).toThrow("fenced or closed");
    index.close();
  });
  it("a FULL candidate never promotes durability and rejects unsupported WAL", () => {
    const db = new sqlite3.oo1.DB(":memory:");
    const candidate = SqliteIndex.open(sqlite3, db, { synchronous: "FULL" });
    expect(db.selectValue("PRAGMA synchronous")).toBe(2);
    expect(candidate.info.durability).toBe("Disposable");
    candidate.close();
    const other = new sqlite3.oo1.DB(":memory:");
    expect(() => SqliteIndex.open(sqlite3, other, { synchronous: "FULL", verifyPragmas: true })).toThrow("requested storage profile");
    other.close();
  });
  it("legacy index still selects NORMAL and rejects unknown profile text", () => {
    const db = new sqlite3.oo1.DB(":memory:");
    const index = SqliteIndex.open(sqlite3, db);
    expect(db.selectValue("PRAGMA synchronous")).toBe(1);
    expect(() => SqliteIndex.open(sqlite3, db, { synchronous: "OFF; DROP TABLE pending" as never })).toThrow("unsupported synchronous profile");
    index.close();
  });
});

describe("app sahpool opening (pool lifecycle mocks)", () => {
  it("invalid scope fails before any VFS call", async () => {
    const installOpfsSAHPoolVfs = vi.fn();
    await expect(openAppSahpoolIndex({ installOpfsSAHPoolVfs }, { ...scope, account: "bad" })).rejects.toThrow("invalid app storage scope");
    expect(installOpfsSAHPoolVfs).not.toHaveBeenCalled();
  });
  it("unsupported storage profile closes handles without wiping files", async () => {
    const db = new sqlite3.oo1.DB(":memory:");
    const close = vi.spyOn(db, "close");
    const pool = { OpfsSAHPoolDb: class { constructor() { return db; } }, pauseVfs: vi.fn(), wipeFiles: vi.fn() };
    const installOpfsSAHPoolVfs = vi.fn(async () => pool);
    await expect(openAppSahpoolIndex({ ...sqlite3, installOpfsSAHPoolVfs }, scope)).rejects.toMatchObject({ kind: "Other", detail: "app SQLite open failed; recovery required" });
    expect(installOpfsSAHPoolVfs).toHaveBeenCalledWith({ name: appPoolNames(scope).vfs, directory: appPoolNames(scope).directory, initialCapacity: 6 });
    expect(close).toHaveBeenCalledOnce();
    expect(pool.pauseVfs).toHaveBeenCalledOnce();
    expect(pool.wipeFiles).not.toHaveBeenCalled();
  });
  it("failed quick_check never wipes state or marks the database clean", async () => {
    const db = new sqlite3.oo1.DB(":memory:");
    SqliteIndex.open(sqlite3, db, { pragmas: false }); // leave clean=0
    const select = db.selectValue.bind(db);
    vi.spyOn(db, "selectValue").mockImplementation((sql) => sql === "PRAGMA journal_mode" ? "wal" : select(sql));
    const exec = vi.spyOn(db, "exec");
    const run = vi.spyOn(SqliteIndex.prototype, "run").mockReturnValueOnce([{ columns: 1, values: [{ kind: "Text", value: "corruption" }], changes: 0n, lastInsertRowid: 0n }]);
    const pool = { OpfsSAHPoolDb: class { constructor() { return db; } }, pauseVfs: vi.fn(), wipeFiles: vi.fn() };
    await expect(openAppSahpoolIndex({ ...sqlite3, installOpfsSAHPoolVfs: async () => pool }, scope)).rejects.toMatchObject({ kind: "Corrupt" });
    expect(run).toHaveBeenCalledWith({ mode: "Autocommit", stmts: [{ sql: "PRAGMA quick_check", params: [] }] });
    expect(exec.mock.calls.some(([sql]) => String(sql).includes("('clean', 1)"))).toBe(false);
    expect(pool.wipeFiles).not.toHaveBeenCalled();
    expect(pool.pauseVfs).toHaveBeenCalledOnce();
  });
  it("open and cleanup errors never leak browser/path messages", async () => {
    const pool = { OpfsSAHPoolDb: class { constructor() { throw new Error("private directory"); } }, pauseVfs: () => { throw new Error("private path"); } };
    await expect(openAppSahpoolIndex({ installOpfsSAHPoolVfs: async () => pool }, scope)).rejects.toMatchObject({ kind: "Other", detail: "app SQLite open failed; recovery required" });
  });
});
