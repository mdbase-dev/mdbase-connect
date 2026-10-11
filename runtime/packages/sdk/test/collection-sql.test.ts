import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppCollectionSql } from "../src/app-storage/collection-sql.js";
import { AppSqliteIndex } from "../src/app-storage/app-sqlite-index.js";
import * as storage from "../src/app-storage/app-sqlite-index.js";
import { SqliteIndex } from "../src/app-storage/sqlite-index.js";
const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const digest = async (value: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value))), b => b.toString(16).padStart(2, "0")).join("");
beforeEach(() => vi.stubGlobal("WorkerGlobalScope", class {static [Symbol.hasInstance](value: unknown) { return value === globalThis; }}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const db = {exec: vi.fn(), close: vi.fn()};
  const index = new AppSqliteIndex(new SqliteIndex({}, db, {durability: "Disposable", opened: "Existing", sqliteVersion: 3053004, quotaSuspect: false}));
  const pool = {pauseVfs: vi.fn()};
  const open = vi.spyOn(storage, "openAppSahpoolIndex").mockResolvedValue({index, pool});
  const options = {wasmSha256: await digest(bytes), maxWasmBytes: 1100000, loadWasm: vi.fn(async () => bytes), initialize: vi.fn(async (_options: {wasmBinary: Uint8Array; print(): void; printErr(): void}) => ({}))};
  return {db, index, pool, open, options, parent: new AbortController()};
}
describe("concrete verified Worker collection SQL", () => {
  it("refuses UI/non-Worker use and bad scope BEFORE asset, initializer or VFS IO", async () => {
    const f = await fixture(); vi.stubGlobal("WorkerGlobalScope", undefined);
    await expect(createAppCollectionSql(f.options)({scope, signal: f.parent.signal})).rejects.toMatchObject({reason: "unsupported"});
    await expect(createAppCollectionSql(f.options)({scope: {...scope, collection: "wrong"}, signal: f.parent.signal})).rejects.toThrow();
    expect(f.options.loadWasm).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it("does not initialize or open storage after checksum, size or pre-open cancellation failure", async () => {
    const f = await fixture();
    await expect(createAppCollectionSql({...f.options, wasmSha256: "00".repeat(32)})({scope, signal: f.parent.signal})).rejects.toMatchObject({reason: "binding"});
    await expect(createAppCollectionSql({...f.options, maxWasmBytes: 1})({scope, signal: f.parent.signal})).rejects.toMatchObject({reason: "binding"});
    f.options.loadWasm.mockImplementation(async () => {f.parent.abort(); return bytes;});
    await expect(createAppCollectionSql(f.options)({scope, signal: f.parent.signal})).rejects.toMatchObject({reason: "fenced"});
    expect(f.options.initialize).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  it("captures BUILD configuration and freezes the byte snapshot before initializer await", async () => {
    const f = await fixture(); const supplied = new Uint8Array(bytes);
    f.options.loadWasm.mockResolvedValue(supplied);
    f.options.initialize.mockImplementation(async () => {supplied.fill(255); return {};});
    const factory = createAppCollectionSql(f.options); f.options.wasmSha256 = "00".repeat(32);
    await factory({scope, signal: f.parent.signal});
    expect(f.options.initialize.mock.calls[0]![0].wasmBinary).toEqual(bytes);
  });
  it("returns acquired cleanup on cancellation so HOST closes SQL AFTER native, never orphans it", async () => {
    const f = await fixture();
    f.open.mockImplementation(async () => {f.parent.abort(); return {index: f.index, pool: f.pool};});
    const result = await createAppCollectionSql(f.options)({scope, signal: f.parent.signal});
    expect(result.sql.needsRecovery).toBe(true); expect(f.db.close).not.toHaveBeenCalled();
    await result.close(); expect(f.db.close).toHaveBeenCalledOnce(); expect(f.db.exec).not.toHaveBeenCalled();
  });
});
