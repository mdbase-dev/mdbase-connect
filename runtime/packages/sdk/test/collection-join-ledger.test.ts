import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCollectionJoinLedger } from "../src/app-host/collection-join-ledger.js";
const scope = {account: "11111111-1111-4111-8111-111111111111", installation: "22222222-2222-4222-8222-222222222222", collection: "33333333-3333-4333-8333-333333333333"};
const databaseName = "existing.application.native-join.v1", key = JSON.stringify(Object.values(scope));
afterEach(() => {vi.unstubAllGlobals();});
function fixture() {
  const state = {exists: false, schema: [] as string[], records: new Map<string, unknown>(), writes: 0, current: true, closed: 0, blocked: false, failed: false, version: 1,
    afterRead: null as null | (() => void), afterCommit: null as null | (() => void)};
  let locked = false; const queue: (() => void)[] = [];
  const release = () => {locked = false; const next = queue.shift(); if (next) {locked = true; queueMicrotask(next);} };
  const enqueue = (work: () => void) => {if (locked) queue.push(work); else {locked = true; queueMicrotask(work);} };
  const open = vi.fn((name: string, version: number) => {
    expect(name).toBe(databaseName); expect(version).toBe(1);
    let schema = [...state.schema], upgradeAborted = false;
    const db = {close: () => {state.closed++;}, objectStoreNames: {get length() {return schema.length;}, contains: (name: string) => schema.includes(name)},
      createObjectStore: (name: string) => {expect(name).toBe("original-join"); schema.push(name);},
      transaction: (store: string, mode: string, options: unknown) => {
        expect(store).toBe("original-join"); expect(mode).toBe("readwrite"); expect(options).toEqual({durability: "strict"});
        let aborted = false, committed = false, next: {key: string; value: unknown} | null = null;
        const tx = {oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void),
          abort: () => {if (committed) throw Error("already committed"); aborted = true;},
          objectStore: () => ({
            get: (recordKey: string) => {
              const request = {result: undefined as unknown, onsuccess: null as null | (() => void)};
              enqueue(() => {
                if (!aborted) {request.result = structuredClone(state.records.get(recordKey)); state.afterRead?.(); request.onsuccess?.();}
                queueMicrotask(() => {
                  if (aborted) tx.onabort?.();
                  else {if (next) {state.records.set(next.key, next.value); state.writes++;} committed = true; state.afterCommit?.(); tx.oncomplete?.();}
                  release();
                });
              }); return request;
            },
            add: (value: unknown, recordKey: string) => {if (state.records.has(recordKey)) throw Error("duplicate"); next = {key: recordKey, value: structuredClone(value)};},
            put: (value: unknown, recordKey: string) => {next = {key: recordKey, value: structuredClone(value)};},
          })}; return tx;
      }};
    const request = {result: db, transaction: {abort: () => {upgradeAborted = true;}}, onblocked: null as null | (() => void), onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null as null | (() => void)};
    queueMicrotask(() => {
      if (state.failed || state.version > 1) {request.onerror?.(); return;}
      if (state.blocked) {request.onblocked?.(); request.onsuccess?.(); return;}
      if (!state.exists) request.onupgradeneeded?.();
      else schema = [...state.schema];
      if (upgradeAborted) {request.onerror?.(); return;}
      state.exists = true; state.schema = [...schema]; request.onsuccess?.();
    }); return request;
  });
  vi.stubGlobal("indexedDB", {open});
  const abort = new AbortController(), options = {databaseName, scope, isCurrent: () => state.current};
  return {state, open, abort, options, ledger: new AppCollectionJoinLedger(options)};
}
describe("original collection join marker (stand-in strict serialized IDB)", () => {
  it("preserves exact original namespace/store/key/record shape and completes only the same tuple", async () => {
    const f = fixture(), first = await f.ledger.prepare({signal: f.abort.signal});
    expect(first).toEqual({outcomeMode: "fresh", phase: "attempted"}); expect(Object.isFrozen(first)).toBe(true);
    expect(f.state.records.get(key)).toEqual({version: 1, ...scope, phase: "attempted"}); expect(f.state.writes).toBe(1);
    await f.ledger.complete({signal: f.abort.signal}); expect(f.state.records.get(key)).toEqual({version: 1, ...scope, phase: "completed"});
    const count = f.state.writes; await f.ledger.complete({signal: f.abort.signal}); expect(f.state.writes).toBe(count);
    expect(await f.ledger.prepare({signal: f.abort.signal})).toEqual({outcomeMode: "existing", phase: "completed"}); expect(f.state.writes).toBe(count);
  });
  it("missing complete refuses without preparing or inventing an operation", async () => {
    const f = fixture(); await expect(f.ledger.complete({signal: f.abort.signal})).rejects.toMatchObject({reason: "recovery_required"}); expect(f.state.records.size).toBe(0); expect(f.state.writes).toBe(0);
  });
  it.each(["account", "extra"]) ("refuses malformed %s without changing original bytes", async field => {
    const f = fixture(); f.state.exists = true; f.state.schema = ["original-join"];
    const original: Record<string, unknown> = {version: 1, ...scope, phase: "attempted"};
    if (["account", "installation", "collection"].includes(field)) original[field] = "44444444-4444-4444-8444-444444444444";
    if (field === "phase") original.phase = "unknown"; if (field === "version") original.version = 2; if (field === "extra") original.alias = "not allowed";
    f.state.records.set(key, field === "null" ? null : original);
    const before = structuredClone(f.state.records);
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "recovery_required"});
    await expect(f.ledger.complete({signal: f.abort.signal})).rejects.toMatchObject({reason: "recovery_required"}); expect(f.state.records).toEqual(before); expect(f.state.writes).toBe(0);
  });
  it("parallel ledger instances serialize: exactly one fresh attempt, loser restores exact winner", async () => {
    const f = fixture(), other = new AppCollectionJoinLedger(f.options);
    const result = await Promise.all([f.ledger.prepare({signal: f.abort.signal}), other.prepare({signal: f.abort.signal})]);
    expect(result).toEqual([{outcomeMode: "fresh", phase: "attempted"}, {outcomeMode: "existing", phase: "attempted"}]); expect(f.state.writes).toBe(1); expect(f.state.records.size).toBe(1);
  });
  it("a duplicate call on the same ledger is busy, without a second database or actor", async () => {
    const f = fixture(), first = f.ledger.prepare({signal: f.abort.signal});
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "busy"}); await first; expect(f.open).toHaveBeenCalledOnce(); expect(f.state.writes).toBe(1);
  });
  it("committed but lost prepare reply restores the exact original attempt", async () => {
    const f = fixture(); f.state.afterCommit = () => f.abort.abort();
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "recovery_required"}); expect(f.state.writes).toBe(1);
    const original = structuredClone(f.state.records); f.state.afterCommit = null;
    expect(await new AppCollectionJoinLedger(f.options).prepare({signal: new AbortController().signal})).toEqual({outcomeMode: "existing", phase: "attempted"}); expect(f.state.records).toEqual(original); expect(f.state.writes).toBe(1);
  });
  it("ownership loss before and during transaction refuses with no marker commit", async () => {
    const f = fixture(); f.state.current = false;
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "fenced"}); expect(f.open).not.toHaveBeenCalled();
    f.state.current = true; f.state.afterRead = () => {f.state.current = false;};
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "fenced"}); expect(f.state.writes).toBe(0);
  });
  it.each(["blocked", "missing-store"]) ("%s never chooses another namespace or resets storage", async mode => {
    const f = fixture(); f.state.exists = true; f.state.schema = ["original-join"];
    if (mode === "blocked") f.state.blocked = true; if (mode === "failed") f.state.failed = true; if (mode === "higher-version") f.state.version = 2;
    if (mode === "missing-store") f.state.schema = []; if (mode === "extra-store") f.state.schema.push("other");
    await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "recovery_required"}); expect(f.open).toHaveBeenCalledOnce(); expect(f.state.writes).toBe(0); expect(f.state.records.size).toBe(0);
  });
  it("pre-aborted or invalid binding refuses before IndexedDB", async () => {
    const f = fixture(); f.abort.abort(); await expect(f.ledger.prepare({signal: f.abort.signal})).rejects.toMatchObject({reason: "fenced"});
    for (const databaseName of ["", "bad\u0000name", "a".repeat(257)]) expect(() => new AppCollectionJoinLedger({...f.options, databaseName})).toThrow("binding");
    expect(() => new AppCollectionJoinLedger({...f.options, scope: {...scope, collection: "00000000-0000-0000-0000-000000000000"}})).toThrow("binding"); expect(f.open).not.toHaveBeenCalled();
  });
});
