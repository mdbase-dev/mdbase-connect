/** First-party opaque Noise vault IO only. No keys, decryption, collection SQL,
 * deletion, replacement, generic KV or retry API. Actual atomic IDB transaction;
 * strict durability is a request, NOT a physical durability/Saved claim. */
import { uuidToBytes } from "../codec.js";
import type { AppDeviceIdentityPin } from "./wasm-runtime.js";
import type { AppNoiseProtectedStore } from "./noise-custody.js";

const STORE = "opaque-noise";
const KEY = "custody";
const MAX = 4096;
const fail = () => new Error("app noise custody store unavailable");
function bytes(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array) || v.byteLength < 1 || v.byteLength > MAX) throw fail();
  return new Uint8Array(v);
}
function same(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);
}
function id(value: string): string {
  const encoded = uuidToBytes(value);
  if (encoded.every(v => v === 0)) throw fail();
  return value.toLowerCase();
}
function current(source: AppDeviceIdentityPin, pins: readonly [string, string, string]): boolean {
  try { return source.isCurrent() === true && source.connectorId === pins[0] && source.deviceId === pins[1] && source.installationId === pins[2]; }
  catch { return false; }
}
export interface AppIndexedDbNoiseOptions {
  /** Exact authenticated host-approved FIRST-PARTY origin, not a grant origin. */
  origin: string;
  /** Explicit installation decision. Missing EXISTING store/blob never => fresh. */
  mode: "fresh" | "existing";
  source: AppDeviceIdentityPin;
  signal: AbortSignal;
  /** Isolated loopback fixtures only; never enables an arbitrary HTTP origin. */
  allowLoopbackHttp?: boolean;
}

export class AppIndexedDbNoiseProtectedStore implements AppNoiseProtectedStore {
  private closed = false;
  private constructor(
    private readonly db: IDBDatabase,
    private readonly source: AppDeviceIdentityPin,
    private readonly pins: readonly [string, string, string],
    private readonly origin: string,
  ) { db.onversionchange = () => this.close(); }

  static async open(options: AppIndexedDbNoiseOptions): Promise<AppIndexedDbNoiseProtectedStore> {
    try { return await this.openChecked(options); } catch { throw fail(); }
  }
  private static async openChecked(options: AppIndexedDbNoiseOptions): Promise<AppIndexedDbNoiseProtectedStore> {
    const { source, signal } = options;
    const pins = [source.connectorId, source.deviceId, source.installationId] as const;
    const endpoint = new URL(options.origin);
    const loopback = options.allowLoopbackHttp === true && endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if ((!loopback && endpoint.protocol !== "https:") || endpoint.origin !== options.origin ||
        endpoint.username || endpoint.password || globalThis.location?.origin !== options.origin ||
        !["fresh", "existing"].includes(options.mode) || signal.aborted || !current(source, pins) ||
        typeof globalThis.indexedDB === "undefined") throw fail();
    const name = `mdbase.app.noise.v1.${id(pins[2])}.${id(pins[0])}.${id(pins[1])}`;
    // Cancellation while blocked cannot authorize a later open/upgrade. Any
    // subsequently delivered database is closed; pending upgrade is aborted.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      let abandoned = false;
      const stop = () => { abandoned = true; reject(fail()); };
      signal.addEventListener("abort", stop, { once: true });
      const finish = () => signal.removeEventListener("abort", stop);
      request.onblocked = stop;
      request.onupgradeneeded = () => {
        if (abandoned || signal.aborted || options.mode !== "fresh" || !current(source, pins) ||
            request.result.objectStoreNames.length !== 0) {
          request.transaction?.abort(); return;
        }
        request.result.createObjectStore(STORE);
      };
      request.onerror = () => { finish(); reject(fail()); };
      request.onsuccess = () => {
        finish();
        if (abandoned || signal.aborted || request.result.objectStoreNames.length !== 1 ||
            !request.result.objectStoreNames.contains(STORE)) { request.result.close(); reject(fail()); return; }
        resolve(request.result);
      };
    });
    const out = new AppIndexedDbNoiseProtectedStore(db, source, pins, options.origin);
    try {
      const existing = await out.read(out.namespace, { signal });
      // Existing ciphertext is never overwritten by a first-install decision.
      // Empty/corrupt existing installation is never silently re-created.
      if ((options.mode === "fresh") !== (existing === null)) throw fail();
      existing?.fill(0);
      out.check(signal);
      return out;
    } catch { out.close(); throw fail(); }
  }

  private get namespace(): string { return `mdbase.app-noise.v1:${this.pins[0]}:${this.pins[1]}:${this.pins[2]}`; }
  private check(signal: AbortSignal, namespace = this.namespace): void {
    if (this.closed || signal.aborted || namespace !== this.namespace || globalThis.location?.origin !== this.origin ||
        !current(this.source, this.pins)) throw fail();
  }
  async read(namespace: string, options: { signal: AbortSignal }): Promise<Uint8Array | null> {
    this.check(options.signal, namespace);
    const out = await this.transaction("readonly", options.signal, null, null);
    try { this.check(options.signal); return out as Uint8Array | null; }
    catch { if (out instanceof Uint8Array) out.fill(0); throw fail(); }
  }
  async compareAndSet(namespace: string, expected: Uint8Array | null, value: Uint8Array, options: { signal: AbortSignal }): Promise<boolean> {
    this.check(options.signal, namespace);
    let old: Uint8Array | null = null, next: Uint8Array | null = null;
    try {
      old = expected === null ? null : bytes(expected); next = bytes(value);
      const out = await this.transaction("readwrite", options.signal, old, next);
      this.check(options.signal); // May be uncertain AFTER commit; never undo it.
      return out === true;
    } finally { old?.fill(0); next?.fill(0); }
  }
  private transaction(mode: IDBTransactionMode, signal: AbortSignal, expected: Uint8Array | null, next: Uint8Array | null): Promise<Uint8Array | null | boolean> {
    return new Promise((resolve, reject) => {
      this.check(signal);
      const tx = this.db.transaction(STORE, mode, { durability: "strict" });
      const store = tx.objectStore(STORE);
      let result: Uint8Array | null | boolean = null;
      let failed = false;
      const abort = () => { failed = true; try { tx.abort(); } catch { /* already committed: preserve */ } };
      const finish = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      tx.onabort = tx.onerror = () => { finish(); if (result instanceof Uint8Array) result.fill(0); reject(fail()); };
      tx.oncomplete = () => {
        finish();
        try { this.check(signal); if (failed) throw fail(); resolve(result); }
        catch { if (result instanceof Uint8Array) result.fill(0); reject(fail()); }
      };
      const request = store.get(KEY);
      request.onsuccess = () => {
        let current: Uint8Array | null = null;
        try {
          this.check(signal);
          current = request.result === undefined ? null : bytes(request.result);
          if (mode === "readonly") { result = current; current = null; }
          else {
            result = same(current, expected);
            if (result === true && next !== null) store.put(new Uint8Array(next), KEY);
          }
        } catch { abort(); }
        finally { current?.fill(0); }
      };
    });
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
