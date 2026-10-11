import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import type { AppLockPort } from "../src/app-host/owner.js";
const crypto = webcrypto as unknown as Crypto, origin = "https://app.example.test", cpOrigin = "https://cp.example.test";
const plain = () => new TextEncoder().encode('{"operation":"original","capability":"test-only"}');
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});
async function fixture(appId = "independent-notes") {
  const sample = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  vi.stubGlobal("crypto", crypto); vi.stubGlobal("CryptoKey", sample.constructor); vi.stubGlobal("location", {origin});
  const state = {exists: false, value: undefined as unknown, writes: 0, held: false, closed: 0, afterCommit: null as null | (() => void), beforeOpen: null as null | (() => void)};
  const locks: AppLockPort = {request: async (name, options, hold) => {
    expect(name).toBe(`mdbase-app-sign-in-v1-${appId}-${cpOrigin}`); expect(options).toEqual({mode: "exclusive", ifAvailable: true});
    if (state.held) {await hold(null); return;} state.held = true; try {await hold({});} finally {state.held = false;}
  }};
  const open = vi.fn((name: string, version: number) => {
    expect(name).toBe(`mdbase.app.installation.v1.${encodeURIComponent(cpOrigin)}.${appId}`); expect(version).toBe(1);
    let aborted = false, created = state.exists, initial: unknown = undefined;
    const db = {close: () => {state.closed++;}, onversionchange: null, objectStoreNames: {get length() {return created ? 1 : 0;}, contains: (s: string) => created && s === "installation-sign-in"},
      createObjectStore: (s: string) => {expect(s).toBe("installation-sign-in"); created = true; return {add: (value: unknown, key: string) => {expect(key).toBe("original"); initial = structuredClone(value);}};},
      transaction: (s: string, mode: string, options: unknown) => {
        expect(s).toBe("installation-sign-in"); expect(options).toEqual({durability: "strict"});
        let stop = false, next: unknown = undefined;
        const tx = {oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void), abort: () => {stop = true; queueMicrotask(() => tx.onabort?.());}, objectStore: () => ({
          get: (key: string) => {expect(key).toBe("original"); const req = {result: undefined as unknown, onsuccess: null as null | (() => void)};
            queueMicrotask(() => {if (stop) return; req.result = structuredClone(state.value); req.onsuccess?.(); queueMicrotask(() => {if (stop) return; if (next !== undefined) {state.value = next; state.writes++; state.afterCommit?.();} tx.oncomplete?.();});}); return req;},
          put: (value: unknown, key: string) => {expect(mode).toBe("readwrite"); expect(key).toBe("original"); next = structuredClone(value);},
        })}; return tx;
      }};
    const req = {result: db, transaction: {abort: () => {aborted = true;}}, onblocked: null as null | (() => void), onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null as null | (() => void)};
    queueMicrotask(() => {state.beforeOpen?.(); if (!state.exists) req.onupgradeneeded?.(); if (aborted) {req.onerror?.(); return;} if (!state.exists && created) {state.exists = true; state.value = initial; state.writes++; state.afterCommit?.();} req.onsuccess?.();}); return req;
  });
  vi.stubGlobal("indexedDB", {open});
  const controller = new AbortController(), options = {origin, cpOrigin, appId, mode: "fresh" as "fresh" | "existing", signal: controller.signal, locks};
  return {state, open, options, controller, sample};
}
describe("pre-account protected operation ledger (real crypto, stand-in strict transactional IDB/WebLocks)", () => {
  it("binds protected ciphertext to the exact generic app identifier", async () => {
    const first = await fixture("app-one"), a = await AppInstallationStore.open(first.options, plain);
    const original = structuredClone(first.state.value); await a.store.close();
    const second = await fixture("app-two"); second.state.exists = true; second.state.value = structuredClone(original);
    await expect(AppInstallationStore.open({...second.options, mode: "existing"}, plain)).rejects.toThrow("preserve storage");
    expect(second.state.value).toEqual(original); expect(second.state.writes).toBe(0); expect(second.state.held).toBe(false);
  });
  it.each(["app/id"])("rejects invalid app ID %s before storage or entropy", async appId => {
    const f = await fixture(appId), initial = vi.fn(plain);
    await expect(AppInstallationStore.open(f.options, initial)).rejects.toThrow("preserve storage");
    expect(initial).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.state.held).toBe(false);
  });
  it("atomic original record contains only nonextractable handle+ciphertext; reopen preserves capability", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain);
    expect(a.plaintext).toEqual(plain()); expect(Object.keys(f.state.value as object).sort()).toEqual(["encrypted", "key", "revision", "version"]);
    const r = f.state.value as {key: CryptoKey; encrypted: Uint8Array}; expect(r.key.extractable).toBe(false); await expect(crypto.subtle.exportKey("raw", r.key)).rejects.toThrow(); expect(new TextDecoder().decode(r.encrypted)).not.toContain("test-only");
    const next = new TextEncoder().encode("confirmed-original"); await a.store.commit(next); expect(f.state.writes).toBe(2); await a.store.close(); expect(f.state.held).toBe(false);
    const initial = vi.fn(plain), b = await AppInstallationStore.open({...f.options, mode: "existing"}, initial); expect(initial).not.toHaveBeenCalled(); expect(b.plaintext).toEqual(next); await b.store.close();
  });
  it("open refuses an occupied database without a record, never repairs it with the candidate", async () => {
    const f = await fixture(); f.state.exists = true;
    await expect(AppInstallationStore.open({...f.options, mode: "open"}, plain)).rejects.toThrow("preserve storage");
    expect(f.state.value).toBeUndefined(); expect(f.state.writes).toBe(0); expect(f.state.held).toBe(false);
  });
  it("open restores a committed initial outcome after its reply was lost", async () => {
    const f = await fixture(); f.state.afterCommit = () => f.controller.abort();
    await expect(AppInstallationStore.open({...f.options, mode: "open"}, plain)).rejects.toThrow("preserve storage");
    const record = structuredClone(f.state.value); f.state.afterCommit = null;
    const b = await AppInstallationStore.open({...f.options, mode: "open", signal: new AbortController().signal}, () => new TextEncoder().encode("unused replacement"));
    expect(b.plaintext).toEqual(plain()); expect(f.state.value).toEqual(record); expect(f.state.writes).toBe(1); await b.store.close();
  });
  it("busy second opener refuses before entropy/schema, never substitutes actor", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain), initial = vi.fn(plain), record = structuredClone(f.state.value);
    await expect(AppInstallationStore.open(f.options, initial)).rejects.toMatchObject({reason: "busy"}); expect(initial).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledTimes(1); expect(f.state.value).toEqual(record); await a.store.close();
  });
  it("fresh-existing, committed empty store and missing existing record preserve storage", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain); await a.store.close(); const record = structuredClone(f.state.value);
    await expect(AppInstallationStore.open(f.options, plain)).rejects.toThrow("preserve storage"); expect(f.state.value).toEqual(record); expect(f.state.writes).toBe(1);
    f.state.value = undefined; await expect(AppInstallationStore.open({...f.options, mode: "existing"}, plain)).rejects.toThrow("preserve storage"); await expect(AppInstallationStore.open(f.options, plain)).rejects.toThrow("preserve storage"); expect(f.state.value).toBeUndefined(); expect(f.state.writes).toBe(1);
  });
  it.each(["cipher"]) ("corrupt %s refuses existing, never replaces handle/capability", async field => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain); await a.store.close(); const r = f.state.value as Record<string, unknown>;
    if (field === "cipher") { const b = r.encrypted as Uint8Array; b[20] = b[20]! ^ 1; }
    if (field === "revision") r.revision = 7;
    if (field === "key") r.key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
    if (field === "extra") r.extra = true;
    if (field === "version") r.version = 2;
    const record = structuredClone(r); await expect(AppInstallationStore.open({...f.options, mode: "existing"}, plain)).rejects.toThrow("preserve storage"); await expect(AppInstallationStore.open({...f.options, mode: "open"}, plain)).rejects.toThrow("preserve storage"); expect(f.state.value).toEqual(record); expect(f.state.writes).toBe(1); expect(f.state.held).toBe(false);
  });
  it("ciphertext CAS detects unexpected record mutation and fences before next write", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain); const b = (f.state.value as {encrypted: Uint8Array}).encrypted; b[20] = b[20]! ^ 1;
    await expect(a.store.commit(plain())).rejects.toThrow("preserve storage"); expect(a.store.isCurrent()).toBe(false); expect(f.state.writes).toBe(1); expect(f.state.held).toBe(false);
  });
  it("committed but lost monotonic-write reply is retained and only existing restore admits it", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain); f.state.afterCommit = () => f.controller.abort(); const next = new TextEncoder().encode("committed-outcome");
    await expect(a.store.commit(next)).rejects.toThrow("preserve storage"); expect(f.state.writes).toBe(2); f.state.afterCommit = null;
    const b = await AppInstallationStore.open({...f.options, mode: "existing", signal: new AbortController().signal}, plain); expect(b.plaintext).toEqual(next); await b.store.close();
  });
  it("source origin changes or parent abort fences before write", async () => {
    const f = await fixture(), a = await AppInstallationStore.open(f.options, plain); vi.stubGlobal("location", {origin: "https://foreign.test"}); await expect(a.store.commit(plain())).rejects.toThrow("preserve storage"); expect(f.state.writes).toBe(1); expect(f.state.held).toBe(false);
  });
  it("protects/restores the 128KiB bounded consent receipt at the exact boundary", async () => {
    const f = await fixture(), value = new Uint8Array(128 * 1024).fill(9);
    const a = await AppInstallationStore.open(f.options, () => new Uint8Array(value)); expect(a.plaintext).toEqual(value); await a.store.close();
    const b = await AppInstallationStore.open({...f.options, mode: "existing"}, plain); expect(b.plaintext).toEqual(value); await b.store.close();
  });
  it("oversized plaintext and pre-aborted/missing-platform refuse before schema", async () => {
    const f = await fixture(); await expect(AppInstallationStore.open(f.options, () => new Uint8Array(128 * 1024 + 1))).rejects.toThrow("preserve storage"); expect(f.open).not.toHaveBeenCalled();
    f.controller.abort(); await expect(AppInstallationStore.open(f.options, plain)).rejects.toThrow("preserve storage"); expect(f.open).not.toHaveBeenCalled(); expect(f.state.held).toBe(false);
  });
});
