// Local slot owner: a CP-assigned appId never selects another app's paired slot.
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AppInstallationStore } from "../src/app-host/installation-store.js";
import type { AppLockPort } from "../src/app-host/owner.js";
const origin = "https://apps.example.test", cpOrigin = "https://cp.example.test", appId = "44444444-4444-4444-8444-444444444444";
const text = (v: string) => new TextEncoder().encode(v), read = (v: Uint8Array) => new TextDecoder().decode(v);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Strict-commit IndexedDB stand-in holding one record per named database. */
async function browser() {
  const dbs = new Map<string, unknown>();
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("location", {origin});
  const sample = await webcrypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  vi.stubGlobal("CryptoKey", sample.constructor);
  const open = vi.fn((name: string) => {
    let created = false, initial: unknown;
    const db = {close: () => {}, onversionchange: null,
      objectStoreNames: {get length() { return dbs.has(name) || created ? 1 : 0; }, contains: () => dbs.has(name) || created},
      createObjectStore: () => { created = true; return {add: (value: unknown) => { initial = structuredClone(value); }}; },
      transaction: () => {
        let next: unknown;
        const tx = {oncomplete: null as null | (() => void), onabort: null as null | (() => void), onerror: null as null | (() => void), abort: () => queueMicrotask(() => tx.onabort?.()),
          objectStore: () => ({
            get: () => { const req = {result: undefined as unknown, onsuccess: null as null | (() => void)};
              queueMicrotask(() => { req.result = structuredClone(dbs.get(name)); req.onsuccess?.(); queueMicrotask(() => { if (next !== undefined) dbs.set(name, next); tx.oncomplete?.(); }); }); return req; },
            put: (value: unknown) => { next = structuredClone(value); },
          })};
        return tx;
      }};
    const req = {result: db, transaction: {abort: () => {}}, onblocked: null, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null};
    queueMicrotask(() => { if (!dbs.has(name)) { req.onupgradeneeded?.(); if (created) dbs.set(name, initial); } req.onsuccess?.(); });
    return req;
  });
  vi.stubGlobal("indexedDB", {open});
  const locks: AppLockPort = {request: async (_name, _options, hold) => { await hold({}); }};
  const options = (owner: string | undefined, mode: "fresh" | "open" | "existing" = "open") =>
    ({origin, cpOrigin, appId, ...(owner === undefined ? {} : {owner}), mode, signal: new AbortController().signal, locks});
  return {dbs, open, options};
}

it("an appId that points at another app's paired slot restores nothing; the owner's own repeat restores", async () => {
  const b = await browser();
  const paired = await AppInstallationStore.open(b.options("bundle:dev.example.notes"), () => text("fresh-notes"));
  await paired.store.commit(text("paired-notes")); await paired.store.close();

  // Another app given the same appId by a wrong registration reply: a fresh slot, not the paired one.
  const other = await AppInstallationStore.open(b.options("bundle:dev.example.reader"), () => text("fresh-reader"));
  expect(read(other.plaintext)).toBe("fresh-reader"); await other.store.close();
  expect(b.dbs.size).toBe(2);

  // Same owner, same appId: the paired record restores.
  const again = await AppInstallationStore.open(b.options("bundle:dev.example.notes"), () => text("unused"));
  expect(read(again.plaintext)).toBe("paired-notes"); await again.store.close();
});

it("never opens an unlabelled slot for an owner, and a moved record does not decrypt under another owner", async () => {
  const b = await browser();
  const legacy = await AppInstallationStore.open(b.options(undefined), () => text("legacy"));
  await legacy.store.close();
  const fresh = await AppInstallationStore.open(b.options("bundle:dev.example.notes"), () => text("fresh-notes"));
  expect(read(fresh.plaintext)).toBe("fresh-notes"); await fresh.store.close();

  const [notesName, record] = [...b.dbs].find(([name]) => name.includes("dev.example.notes"))!;
  const readerName = notesName.replace(encodeURIComponent("bundle:dev.example.notes"), encodeURIComponent("bundle:dev.example.reader"));
  b.dbs.set(readerName, structuredClone(record));
  await expect(AppInstallationStore.open(b.options("bundle:dev.example.reader", "existing"), () => text("unused"))).rejects.toThrow("preserve storage");
});
