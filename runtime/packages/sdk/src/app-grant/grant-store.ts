/**
 * Persistence for application grants (`MdbaseAppGrants`).
 *
 * **What is stored, and how.** The SDK's protected-storage pattern for browser
 * secrets (the same one the installation sign-in ledger and device-key custody use):
 * - The grant's Noise static key and the installation signing key are
 *   **non-extractable WebCrypto keys** (`X25519` / `ECDSA P-256`), structured-cloned
 *   into IndexedDB. Page script can use them, but cannot read their bytes.
 * - The refresh token is stored only as **AES-256-GCM ciphertext** under a
 *   per-grant non-extractable key kept beside it, with associated data binding the
 *   control-plane origin, the app's local owner and collection. It is never in `localStorage`,
 *   `sessionStorage`, cookies, URLs or logs.
 * - Access tokens are kept in memory only.
 * - The default store is labelled with the app's local owner (`bundle:<manifest
 *   id>` from its own declaration): the database name and every record carry it,
 *   so a CP-assigned id can never select another app's identity or grants.
 *
 * **Limit.** Non-extractable keys stop script from *reading* the secrets (so an
 * injected script cannot copy them out of storage and use them elsewhere). They do
 * not stop same-origin script that runs while the app is open from *using* them; no
 * browser storage can. Apps still need a strict CSP.
 */
import { isInstallationOwner } from "../app-host/installation-store.js";
import { mdbaseError } from "../errors.js";

/** The installation's signing identity: one per CP origin and application. */
export interface StoredAppIdentity {
  readonly version: 1;
  /** ECDSA P-256, `sign` only, non-extractable. */
  readonly privateKey: CryptoKey;
  /** base64url of the uncompressed P-256 point (65 bytes). */
  readonly publicKey: string;
  /** The store's local owner, stamped by an owner-labelled store. */
  readonly owner?: string;
}

/** One grant: a collection this app was given access to. */
export interface StoredAppGrant {
  readonly version: 1;
  readonly collection: string;
  /** X25519, `deriveBits`, non-extractable: the grant's registered client key. */
  readonly noisePrivateKey: CryptoKey;
  readonly noisePublicKey: Uint8Array;
  /** AES-256-GCM, non-extractable; encrypts `refresh` only. */
  readonly refreshKey: CryptoKey;
  /** `iv (12) ‖ ciphertext`. */
  readonly refresh: Uint8Array;
  /** Epoch ms after which the refresh token is no longer accepted. */
  readonly refreshExpiresAt: number;
  /** The store's local owner, stamped by an owner-labelled store. */
  readonly owner?: string;
}

export interface AppGrantStore {
  getIdentity(): Promise<StoredAppIdentity | undefined>;
  /** Keep an existing identity, or commit this one. Never replaces. */
  putIdentityIfAbsent(identity: StoredAppIdentity): Promise<StoredAppIdentity>;
  getGrant(collection: string): Promise<StoredAppGrant | undefined>;
  listGrants(): Promise<StoredAppGrant[]>;
  putGrant(grant: StoredAppGrant): Promise<void>;
  deleteGrant(collection: string): Promise<void>;
}

/** In memory only (tests and short-lived scripts). */
export function memoryAppGrantStore(): AppGrantStore {
  let identity: StoredAppIdentity | undefined;
  const grants = new Map<string, StoredAppGrant>();
  return {
    getIdentity: async () => identity,
    putIdentityIfAbsent: async (next) => (identity ??= next),
    getGrant: async (collection) => grants.get(collection),
    listGrants: async () => [...grants.values()],
    putGrant: async (grant) => void grants.set(grant.collection, grant),
    deleteGrant: async (collection) => void grants.delete(collection),
  };
}

const IDENTITY = "identity", GRANTS = "grants";

export interface IndexedDbAppGrantStoreOptions {
  /**
   * Stable local owner of this store, from the ORIGINAL application declaration
   * (`bundle:<manifest id>`), never the CP-assigned application id. When set, the
   * database name and every stored record carry it, and records with another
   * owner are refused, so an application id that points at another app's store
   * opens an empty database instead. Unlabelled stores are never opened for an
   * owner: that app grants afresh, and nothing is deleted.
   *
   * Without it the store is addressed by `applicationId` alone: use that only
   * with an id the app fixes itself, never one returned by registration.
   */
  readonly owner?: string;
}

function refused(): never {
  throw mdbaseError("unauthenticated", "the stored grant belongs to another app", "grant_storage");
}

/**
 * IndexedDB, one database per control-plane origin, local owner and application.
 * `MdbaseAppGrants` uses this with `owner: "bundle:<manifest id>"` by default.
 */
export function indexedDbAppGrantStore(cpOrigin: string, applicationId: string, options: IndexedDbAppGrantStoreOptions = {}): AppGrantStore {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) throw mdbaseError("unavailable", "IndexedDB is not available here", "grant_storage");
  const owner = options.owner;
  if (owner !== undefined && !isInstallationOwner(owner)) throw mdbaseError("invalid_request", "invalid grant store owner", "grant_storage");
  const name = owner === undefined
    ? `mdbase.app-grants.v1.${encodeURIComponent(cpOrigin)}.${applicationId}`
    : `mdbase.app-grants.v2.${encodeURIComponent(cpOrigin)}.${encodeURIComponent(owner)}.${applicationId}`;
  // Labelled stores stamp their owner on every record and refuse any other.
  const mine = <T extends { owner?: string }>(record: T | undefined): T | undefined => {
    if (record === undefined || owner === undefined) return record;
    return record.owner === owner ? record : refused();
  };
  const ownedOrAbsent = (record: unknown) =>
    owner === undefined || record === undefined || (record as { owner?: unknown }).owner === owner;
  const stamp = <T extends object>(record: T): T => owner === undefined ? record : { ...record, owner };
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDENTITY);
      req.result.createObjectStore(GRANTS);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = null; };
      resolve(req.result);
    };
    req.onerror = () => { opening = null; reject(mdbaseError("unavailable", "grant storage could not be opened", "grant_storage")); };
  }));
  const run = async <T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode, { durability: "strict" });
      let result: T, captured = false;
      tx.oncomplete = () => captured ? resolve(result) : reject(mdbaseError("unavailable", "grant storage returned no result", "grant_storage"));
      tx.onabort = tx.onerror = () => reject(mdbaseError("unavailable", "grant storage transaction failed", "grant_storage"));
      try { work(tx.objectStore(store), (v) => { result = v; captured = true; }); }
      catch { try { tx.abort(); } catch { /* already finished */ } }
    });
  };
  const get = <T>(store: string, key: string) => run<T | undefined>(store, "readonly", (s, done) => {
    const r = s.get(key); r.onsuccess = () => done(r.result as T | undefined);
  });
  return {
    getIdentity: async () => mine(await get<StoredAppIdentity>(IDENTITY, "installation")),
    putIdentityIfAbsent: async (identity) => mine(await run<StoredAppIdentity>(IDENTITY, "readwrite", (s, done) => {
      const r = s.get("installation");
      r.onsuccess = () => {
        if (r.result !== undefined) return done(r.result as StoredAppIdentity);
        const next = stamp(identity);
        s.add(next, "installation").onsuccess = () => done(next);
      };
    }))!,
    getGrant: async (collection) => mine(await get<StoredAppGrant>(GRANTS, collection)),
    listGrants: async () => (await run<StoredAppGrant[]>(GRANTS, "readonly", (s, done) => {
      const r = s.getAll(); r.onsuccess = () => done(r.result as StoredAppGrant[]);
    })).map((grant) => mine(grant)!),
    // Never overwrite or delete a record another owner wrote.
    putGrant: async (grant) => {
      const outcome = await run<"done" | "refused">(GRANTS, "readwrite", (s, done) => {
        const r = s.get(grant.collection);
        r.onsuccess = () => {
          if (!ownedOrAbsent(r.result)) return done("refused");
          s.put(stamp(grant), grant.collection).onsuccess = () => done("done");
        };
      });
      if (outcome === "refused") refused();
    },
    deleteGrant: async (collection) => {
      const outcome = await run<"done" | "refused">(GRANTS, "readwrite", (s, done) => {
        const r = s.get(collection);
        r.onsuccess = () => {
          if (!ownedOrAbsent(r.result)) return done("refused");
          s.delete(collection).onsuccess = () => done("done");
        };
      });
      if (outcome === "refused") refused();
    },
  };
}
