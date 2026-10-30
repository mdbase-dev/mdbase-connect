/**
 * Persistence for application grants (`MdbaseAppGrants`).
 *
 * **What is stored, and how.** The SDK's protected-storage pattern for browser
 * secrets (the same one the installation sign-in ledger and device-key custody use):
 * - The grant's Noise static key, its signing key and the installation signing key
 *   are **non-extractable WebCrypto keys** (`X25519` / `ECDSA P-256`), structured-cloned
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
import { isInstallationOwner } from "../app-host/owner.js";
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
  /** ECDSA P-256, `sign` only, non-extractable: the grant signing key registered at
   * consent, which signs refresh requests. Absent in grants stored before it was
   * kept; Connect refuses their refresh, so the app asks for access again. */
  readonly signingPrivateKey?: CryptoKey;
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
  /**
   * Remove EVERY grant and Native setup attempt (sign-out). Grants carry no
   * account, so a per-collection list can miss one (e.g. persisted a moment
   * before a reload, before its completion was recorded); only a whole-store
   * wipe leaves none behind for the next account on a shared browser. Setup
   * attempts are encrypted under a grant's own key and bound to its Noise
   * key, so without their grant they are inert — but they would block a
   * future grant for the same collection from setting up, so they go too.
   * Never touches the identity: that is the app's registration, not account
   * authority. Never deletes a record another owner wrote: throws instead
   * (the caller's own records are still removed first).
   */
  clearGrants(): Promise<void>;
  /** Protected opaque Native setup attempts; never mutation bodies or replay queues. */
  getSetupAttempt?(collection: string): Promise<Uint8Array | undefined>;
  putSetupAttemptIfAbsent?(collection: string, bytes: Uint8Array): Promise<Uint8Array>;
  deleteSetupAttempt?(collection: string, expected: Uint8Array): Promise<void>;
}

/** In memory only (tests and short-lived scripts). */
export function memoryAppGrantStore(): AppGrantStore {
  let identity: StoredAppIdentity | undefined;
  const grants = new Map<string, StoredAppGrant>();
  const attempts = new Map<string, Uint8Array>();
  return {
    getIdentity: async () => identity,
    putIdentityIfAbsent: async (next) => (identity ??= next),
    getGrant: async (collection) => grants.get(collection),
    listGrants: async () => [...grants.values()],
    putGrant: async (grant) => void grants.set(grant.collection, grant),
    deleteGrant: async (collection) => void grants.delete(collection),
    clearGrants: async () => { grants.clear(); attempts.clear(); },
    getSetupAttempt: async c => attempts.get(c)?.slice(),
    putSetupAttemptIfAbsent: async (c,b) => { if(!attempts.has(c)) attempts.set(c,b.slice()); return attempts.get(c)!.slice(); },
    deleteSetupAttempt: async (c,b) => { const a=attempts.get(c); if(a && a.length===b.length && a.every((v,i)=>v===b[i])) attempts.delete(c); },
  };
}

const IDENTITY = "identity", GRANTS = "grants", SETUP_ATTEMPTS = "native-setup-attempts";

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
    const req = idb.open(name, 2);
    req.onupgradeneeded = () => {
      for(const store of [IDENTITY,GRANTS,SETUP_ATTEMPTS]) if(!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = null; };
      resolve(req.result);
    };
    req.onerror = () => { opening = null; reject(mdbaseError("unavailable", "grant storage could not be opened", "grant_storage")); };
  }));
  const transact = async <T>(stores: readonly string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, done: (v: T) => void) => void): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([...stores], mode, { durability: "strict" });
      let result: T, captured = false;
      tx.oncomplete = () => captured ? resolve(result) : reject(mdbaseError("unavailable", "grant storage returned no result", "grant_storage"));
      tx.onabort = tx.onerror = () => reject(mdbaseError("unavailable", "grant storage transaction failed", "grant_storage"));
      try { work(tx, (v) => { result = v; captured = true; }); }
      catch { try { tx.abort(); } catch { /* already finished */ } }
    });
  };
  const run = <T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore, done: (v: T) => void) => void): Promise<T> =>
    transact([store], mode, (tx, done) => work(tx.objectStore(store), done));
  const get = <T>(store: string, key: string) => run<T | undefined>(store, "readonly", (s, done) => {
    const r = s.get(key); r.onsuccess = () => done(r.result as T | undefined);
  });
  return {
    getSetupAttempt: async c => mine(await get<{owner?:string;bytes:Uint8Array}>(SETUP_ATTEMPTS,c))?.bytes,
    putSetupAttemptIfAbsent: async (c,bytes) => mine(await run<{owner?:string;bytes:Uint8Array}>(SETUP_ATTEMPTS,"readwrite",(s,done)=>{
      const r=s.get(c); r.onsuccess=()=> { if(r.result!==undefined) return done(r.result); const row=stamp({bytes:bytes.slice()}); s.add(row,c).onsuccess=()=>done(row); };
    }))!.bytes,
    deleteSetupAttempt: async (c,expected) => {
      const outcome=await run<"done"|"refused">(SETUP_ATTEMPTS,"readwrite",(s,done)=>{
        const r=s.get(c); r.onsuccess=()=> { if(!ownedOrAbsent(r.result)) return done("refused"); const b=(r.result as {bytes:Uint8Array}|undefined)?.bytes;
          if(!b || b.length!==expected.length || !b.every((v,i)=>v===expected[i])) return done("done"); s.delete(c).onsuccess=()=>done("done"); };
      }); if(outcome==="refused") refused();
    },
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
    // One transaction over grants + setup attempts. Another owner's records
    // stay (as deleteGrant refuses them) but ours are removed and we report.
    clearGrants: async () => {
      const outcome = await transact<"done" | "refused">([GRANTS, SETUP_ATTEMPTS], "readwrite", (tx, done) => {
        let other = false, pending = 2;
        const finish = () => { if (--pending === 0) done(other ? "refused" : "done"); };
        for (const store of [GRANTS, SETUP_ATTEMPTS]) {
          const s = tx.objectStore(store);
          if (owner === undefined) { s.clear().onsuccess = finish; continue; }
          const r = s.openCursor();
          r.onsuccess = () => {
            const cursor = r.result;
            if (!cursor) return finish();
            if (ownedOrAbsent(cursor.value)) cursor.delete(); else other = true;
            cursor.continue();
          };
        }
      });
      if (outcome === "refused") refused();
    },
  };
}
