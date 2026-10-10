/** Exact-scope bootstrap ciphertext IO. No generic KV, reset/delete or retry.
 * Host must hold Worker/installation/collection ownership BEFORE open/crypto.
 * Strict IDB durability is a request, never a Saved/power-loss claim. */
import { uuidToBytes } from "../codec.js";
import type { AppCpPrivateSession } from "./private-bootstrap.js";
import { APP_PRIVATE_BOOTSTRAP_CIPHER_MAX, type AppPrivateBootstrapProtectedStore } from "./private-persistence.js";
const STORE = "public-outcome", KEY = "operation";
const bad = () => new Error("app private bootstrap store unavailable");
const same = (a: Uint8Array | null, b: Uint8Array | null) => a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
function bytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || !value.length || value.length > APP_PRIVATE_BOOTSTRAP_CIPHER_MAX) throw bad(); return new Uint8Array(value);
}
export interface AppIndexedDbPrivateBootstrapOptions {
  readonly source: AppCpPrivateSession;
  /** Exact authenticated FIRST-PARTY app origin (not CP/grant origin). */
  readonly origin: string;
  /** Explicit operation-record decision, not inferred from missing custody. */
  readonly mode: "fresh" | "existing";
  readonly signal: AbortSignal;
  readonly allowLoopbackHttp?: boolean;
}
export class AppIndexedDbPrivateBootstrapStore implements AppPrivateBootstrapProtectedStore {
  private closed = false;
  private constructor(private readonly db: IDBDatabase, private readonly source: AppCpPrivateSession,
    private readonly pins: Readonly<{ accountId: string; connectorId: string; deviceId: string; installationId: string; collection: string; purpose: "create" | "enrol"; cpOrigin: string; logOrigin: string }>,
    private readonly root: Uint8Array, private readonly origin: string) { db.onversionchange = () => this.close(); }
  static async open(options: AppIndexedDbPrivateBootstrapOptions): Promise<AppIndexedDbPrivateBootstrapStore> {
    try { return await this.openChecked(options); } catch { throw bad(); }
  }
  private static async openChecked(options: AppIndexedDbPrivateBootstrapOptions): Promise<AppIndexedDbPrivateBootstrapStore> {
    const { source, signal } = options;
    const pins = Object.freeze({ accountId: source.accountId, connectorId: source.connectorId, deviceId: source.deviceId, installationId: source.installationId,
      collection: source.collection, purpose: source.purpose, cpOrigin: source.cpOrigin, logOrigin: source.logOrigin });
    const ids = [pins.accountId, pins.connectorId, pins.deviceId, pins.installationId, pins.collection];
    for (const id of ids) if (uuidToBytes(id).every(v => v === 0)) throw bad();
    if (!(source.rootPublicKey instanceof Uint8Array) || source.rootPublicKey.length !== 32 || source.rootPublicKey.every(v => v === 0)) throw bad();
    const root = new Uint8Array(source.rootPublicKey);
    const origin = new URL(options.origin), loopback = options.allowLoopbackHttp === true && origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if ((!loopback && origin.protocol !== "https:") || origin.origin !== options.origin || origin.username || origin.password ||
      globalThis.location?.origin !== options.origin || !["fresh", "existing"].includes(options.mode) || !["create", "enrol"].includes(pins.purpose) || !globalThis.indexedDB) throw bad();
    const current = () => { try { return !signal.aborted && source.isCurrent() === true && source.approvalMode === "password-ak1" &&
      source.rootPublicKey instanceof Uint8Array && same(source.rootPublicKey, root) && Object.entries(pins).every(([k, v]) => source[k as keyof AppCpPrivateSession] === v); } catch { return false; } };
    if (!current()) throw bad();
    const name = `mdbase.app.private-bootstrap.v1.${ids.map(id => id.toLowerCase()).join(".")}.${pins.purpose}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1); let abandoned = false;
      const stop = () => { abandoned = true; reject(bad()); }, finish = () => signal.removeEventListener("abort", stop);
      signal.addEventListener("abort", stop, { once: true }); request.onblocked = stop;
      request.onupgradeneeded = () => {
        if (abandoned || !current() || options.mode !== "fresh" || request.result.objectStoreNames.length !== 0) { request.transaction?.abort(); return; }
        request.result.createObjectStore(STORE);
      };
      request.onerror = () => { finish(); reject(bad()); };
      request.onsuccess = () => {
        finish(); if (abandoned || !current() || request.result.objectStoreNames.length !== 1 || !request.result.objectStoreNames.contains(STORE)) { request.result.close(); reject(bad()); return; } resolve(request.result);
      };
    });
    const out = new AppIndexedDbPrivateBootstrapStore(db, source, pins, root, options.origin);
    try {
      const existing = await out.read({ signal });
      if ((options.mode === "fresh") !== (existing === null)) throw bad(); existing?.fill(0); out.check(signal); return out;
    } catch { out.close(); throw bad(); }
  }
  private check(signal: AbortSignal): void {
    try { if (this.closed || signal.aborted || globalThis.location?.origin !== this.origin || this.source.isCurrent() !== true || this.source.approvalMode !== "password-ak1" ||
      !(this.source.rootPublicKey instanceof Uint8Array) || !same(this.source.rootPublicKey, this.root) || Object.entries(this.pins).some(([k, v]) => this.source[k as keyof AppCpPrivateSession] !== v)) throw bad(); }
    catch { throw bad(); }
  }
  async read(options: { signal: AbortSignal }): Promise<Uint8Array | null> {
    this.check(options.signal); const value = await this.transaction("readonly", options.signal, null, null);
    this.check(options.signal); return value as Uint8Array | null;
  }
  async compareAndSet(expected: Uint8Array | null, encrypted: Uint8Array, options: { signal: AbortSignal }): Promise<boolean> {
    this.check(options.signal); let old: Uint8Array | null = null, next: Uint8Array | null = null;
    try { old = expected === null ? null : bytes(expected); next = bytes(encrypted);
      const result = await this.transaction("readwrite", options.signal, old, next); this.check(options.signal); return result === true;
    } finally { old?.fill(0); next?.fill(0); }
  }
  private transaction(mode: IDBTransactionMode, signal: AbortSignal, expected: Uint8Array | null, next: Uint8Array | null): Promise<Uint8Array | null | boolean> {
    return new Promise((resolve, reject) => {
      this.check(signal); const tx = this.db.transaction(STORE, mode, { durability: "strict" }); const store = tx.objectStore(STORE);
      let result: Uint8Array | null | boolean = null, failed = false;
      const abort = () => { failed = true; try { tx.abort(); } catch { /* uncertain committed outcome preserved */ } };
      const finish = () => signal.removeEventListener("abort", abort); signal.addEventListener("abort", abort, { once: true });
      tx.onabort = tx.onerror = () => { finish(); if (result instanceof Uint8Array) result.fill(0); reject(bad()); };
      tx.oncomplete = () => { finish(); try { this.check(signal); if (failed) throw bad(); resolve(result); } catch { if (result instanceof Uint8Array) result.fill(0); reject(bad()); } };
      const request = store.get(KEY);
      request.onsuccess = () => {
        let existing: Uint8Array | null = null;
        try { this.check(signal); existing = request.result === undefined ? null : bytes(request.result);
          if (mode === "readonly") { result = existing; existing = null; } else { result = same(existing, expected); if (result === true && next !== null) store.put(new Uint8Array(next), KEY); }
        } catch { abort(); } finally { existing?.fill(0); }
      };
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
