/** Internal pre-account sign-in ledger. Nonextractable origin AES handle + bounded
 * encrypted operation in ONE strict IDB commit. Not an account KEK, generic KV,
 * OS keychain, XSS boundary or physical durability/collection Saved guarantee. */
import { acquireAppSignInLease, AppReplicaOwnerError, type AppLockPort, type AppReplicaLease } from "./owner.js";
const STORE = "installation-sign-in", KEY = "original", MAX = 128 * 1024; // bounded original + additive consent receipts (<=1000 IDs each)
export class AppInstallationStorageError extends Error {
  constructor(readonly reason: "busy" | "unavailable") { super(`app installation storage ${reason}; preserve storage and reopen`); }
}
const fail = (reason: AppInstallationStorageError["reason"] = "unavailable") => new AppInstallationStorageError(reason);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
function kek(v: unknown): CryptoKey {
  if (typeof CryptoKey !== "function" || !(v instanceof CryptoKey) || v.type !== "secret" || v.extractable || v.algorithm.name !== "AES-GCM" || (v.algorithm as AesKeyAlgorithm).length !== 256 || v.usages.length !== 2 || !v.usages.includes("encrypt") || !v.usages.includes("decrypt")) throw fail();
  return v;
}
interface Stored { version: 1; revision: number; key: CryptoKey; encrypted: Uint8Array }
function stored(v: unknown): Stored {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "encrypted,key,revision,version") throw fail();
  const r = v as Stored;
  if (r.version !== 1 || !Number.isSafeInteger(r.revision) || r.revision < 0 || !(r.encrypted instanceof Uint8Array) || r.encrypted.length < 29 || r.encrypted.length > MAX + 28) throw fail();
  return { version: 1, revision: r.revision, key: kek(r.key), encrypted: new Uint8Array(r.encrypted) };
}
export interface AppInstallationStoreOptions {
  readonly origin: string;
  /** Authenticated first-party build context, never supplied by a redirect. */
  readonly cpOrigin: string;
  readonly appId: "tasknotes-web" | "tasknotes-mobile";
  readonly mode: "fresh" | "existing";
  readonly signal: AbortSignal;
  readonly locks: AppLockPort | undefined;
  readonly allowLoopbackHttp?: boolean;
}
/** Deliberately NOT exported from the package entrypoint. Only the fixed sign-in
 * lifecycle uses its bounded ciphertext CAS; no secrets/handle loan API. */
export class AppInstallationStore {
  private db: IDBDatabase | null = null;
  private record: Stored | null = null;
  private closing = false;
  private closeResult: Promise<void> | null = null;
  private readonly namespace: string;
  private constructor(private readonly options: Readonly<AppInstallationStoreOptions>, private readonly lease: AppReplicaLease) {
    this.namespace = JSON.stringify(["mdbase.app-installation.v1", options.origin, options.cpOrigin, options.appId]);
  }
  static async open(options: AppInstallationStoreOptions, initial: () => Uint8Array): Promise<{store: AppInstallationStore; plaintext: Uint8Array}> {
    // Snapshot before any ownership/platform wait. No account ID is invented.
    const p = Object.freeze({ origin: options.origin, cpOrigin: options.cpOrigin, appId: options.appId, mode: options.mode, signal: options.signal, locks: options.locks, allowLoopbackHttp: options.allowLoopbackHttp === true });
    let out: AppInstallationStore | null = null, plain: Uint8Array | null = null, fresh: Stored | null = null;
    try {
      for (const origin of [p.origin, p.cpOrigin]) {
        const u = new URL(origin), loopback = p.allowLoopbackHttp && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
        if (u.origin !== origin || u.username || u.password || (u.protocol !== "https:" && !loopback)) throw fail();
      }
      if (!["fresh", "existing"].includes(p.mode) || !["tasknotes-web", "tasknotes-mobile"].includes(p.appId) || p.signal.aborted || globalThis.location?.origin !== p.origin || !globalThis.indexedDB || !globalThis.crypto?.subtle || typeof CryptoKey !== "function") throw fail();
      const lease = await acquireAppSignInLease(p.locks, p, p.signal);
      out = new AppInstallationStore(p, lease); out.check();
      if (p.mode === "fresh") {
        // Ownership precedes randomness/crypto; commit initial tuple, secret and
        // handle atomically in the upgrade transaction, never an empty fresh DB.
        plain = initial(); out.check(); out.bound(plain);
        const key = kek(await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"])); out.check();
        fresh = {version: 1, revision: 0, key, encrypted: await out.encrypt(key, 0, plain)};
        plain.fill(0); plain = null;
      }
      out.db = await out.openDatabase(fresh); out.check();
      out.db.onversionchange = () => { void out!.close(); };
      out.record = await out.readRecord(); out.check();
      plain = await out.decrypt(out.record); out.check(); out.bound(plain);
      const result = {store: out, plaintext: plain}; plain = null; return result;
    } catch (e) { await out?.close(); throw fail(e instanceof AppReplicaOwnerError && e.reason === "busy" ? "busy" : "unavailable"); }
    finally { plain?.fill(0); fresh?.encrypted.fill(0); }
  }
  isCurrent(): boolean { try { this.check(); return true; } catch { return false; } }
  private check(): void {
    if (this.closing || this.options.signal.aborted || globalThis.location?.origin !== this.options.origin) throw fail();
  }
  private bound(b: Uint8Array): void { if (!(b instanceof Uint8Array) || !b.length || b.length > MAX) throw fail(); }
  private aad(revision: number): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(`${this.namespace}:${revision}`); }
  private async encrypt(key: CryptoKey, revision: number, plain: Uint8Array): Promise<Uint8Array> {
    this.check(); this.bound(plain);
    const iv = crypto.getRandomValues(new Uint8Array(12)), aad = this.aad(revision), input = new Uint8Array(plain);
    let cipher: Uint8Array | null = null;
    try {
      cipher = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv, additionalData: aad}, key, input)); this.check();
      const out = new Uint8Array(12 + cipher.length); out.set(iv); out.set(cipher, 12); return out;
    } finally { input.fill(0); cipher?.fill(0); iv.fill(0); aad.fill(0); }
  }
  private async decrypt(r: Stored): Promise<Uint8Array> {
    this.check(); const aad = this.aad(r.revision), iv = new Uint8Array(r.encrypted.subarray(0, 12)), input = new Uint8Array(r.encrypted.subarray(12));
    try {
      const plain = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv, additionalData: aad}, r.key, input));
      try { this.check(); this.bound(plain); return plain; } catch { plain.fill(0); throw fail(); }
    } finally { iv.fill(0); input.fill(0); aad.fill(0); }
  }
  private openDatabase(fresh: Stored | null): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      this.check(); const name = `mdbase.app.installation.v1.${encodeURIComponent(this.options.cpOrigin)}.${this.options.appId}`, req = indexedDB.open(name, 1);
      let abandoned = false, created = false;
      const stop = () => { abandoned = true; try { req.transaction?.abort(); } catch { /* preserve any commit */ } reject(fail()); };
      const finish = () => this.options.signal.removeEventListener("abort", stop);
      this.options.signal.addEventListener("abort", stop, {once: true}); req.onblocked = stop;
      req.onupgradeneeded = () => { try { this.check(); if (abandoned || !fresh || req.result.objectStoreNames.length) throw fail(); req.result.createObjectStore(STORE).add(fresh, KEY); created = true; } catch { req.transaction?.abort(); } };
      req.onerror = () => { finish(); reject(fail()); };
      req.onsuccess = () => { finish(); try { this.check(); if (abandoned || (fresh !== null && !created) || req.result.objectStoreNames.length !== 1 || !req.result.objectStoreNames.contains(STORE)) throw fail(); resolve(req.result); } catch { req.result.close(); reject(fail()); } };
    });
  }
  private readRecord(): Promise<Stored> {
    return new Promise((resolve, reject) => {
      this.check(); if (!this.db) throw fail();
      const tx = this.db.transaction(STORE, "readonly", {durability: "strict"}); let result: Stored | null = null;
      const abort = () => { try { tx.abort(); } catch { /* preserve */ } }, finish = () => this.options.signal.removeEventListener("abort", abort);
      this.options.signal.addEventListener("abort", abort, {once: true});
      tx.onerror = tx.onabort = () => { finish(); result?.encrypted.fill(0); reject(fail()); };
      tx.oncomplete = () => { finish(); try { this.check(); if (!result) throw fail(); resolve(result); } catch { result?.encrypted.fill(0); reject(fail()); } };
      const req = tx.objectStore(STORE).get(KEY); req.onsuccess = () => { try { this.check(); result = stored(req.result); } catch { abort(); } };
    });
  }
  /** Fixed lifecycle monotonic CAS. Any uncertain write fences this object;
   * reopen EXISTING and decrypt the exact committed state before more HTTP. */
  async commit(plaintext: Uint8Array): Promise<void> {
    let next: Stored | null = null;
    try {
      this.check(); if (!this.record || this.record.revision >= Number.MAX_SAFE_INTEGER) throw fail();
      const prior = this.record;
      next = {version: 1, revision: prior.revision + 1, key: prior.key, encrypted: await this.encrypt(prior.key, prior.revision + 1, plaintext)}; this.check();
      await new Promise<void>((resolve, reject) => {
        this.check(); if (!this.db) throw fail(); const tx = this.db.transaction(STORE, "readwrite", {durability: "strict"});
        const abort = () => { try { tx.abort(); } catch { /* possible commit remains */ } }, finish = () => this.options.signal.removeEventListener("abort", abort);
        this.options.signal.addEventListener("abort", abort, {once: true});
        tx.onerror = tx.onabort = () => { finish(); reject(fail()); };
        tx.oncomplete = () => { finish(); try { this.check(); resolve(); } catch { reject(fail()); } };
        const store = tx.objectStore(STORE), req = store.get(KEY);
        req.onsuccess = () => { let old: Stored | null = null; try { this.check(); old = stored(req.result); if (old.revision !== prior.revision || !equal(old.encrypted, prior.encrypted)) throw fail(); store.put(next!, KEY); } catch { abort(); } finally { old?.encrypted.fill(0); } };
      });
      this.check(); prior.encrypted.fill(0); this.record = next; next = null;
    } catch { await this.close(); throw fail(); }
    finally { next?.encrypted.fill(0); }
  }
  close(): Promise<void> {
    return this.closeResult ??= (async () => { this.closing = true; this.db?.close(); this.db = null; this.record?.encrypted.fill(0); this.record = null; await this.lease.release(); })();
  }
}
