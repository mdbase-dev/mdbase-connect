/**
 * Client static keys (`replica-client-api.md` §12.3, "Keys for web apps").
 *
 * A browser app generates its X25519 static key once and registers the public key in
 * its grant at consent time. Where the platform supports it, the private key is a
 * **non-extractable WebCrypto key kept in IndexedDB**: page script can use it for the
 * handshake but cannot read it out. Otherwise the raw key is kept in IndexedDB, scoped
 * to the app's origin, and `nonExtractable` is false so the app can tell.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { mdbaseError } from "./errors.js";
import type { StaticKey } from "./transport/noise.js";

export interface ClientKey extends StaticKey {
  /** True when the private key can't be exported by page script. */
  readonly nonExtractable: boolean;
}

/** What a key store persists for one key. CryptoKeys are structured-cloneable. */
export type StoredKey =
  | { kind: "webcrypto"; privateKey: CryptoKey; publicKey: Uint8Array }
  | { kind: "raw"; secretKey: Uint8Array; publicKey: Uint8Array };

export interface KeyStorage {
  get(name: string): Promise<StoredKey | undefined>;
  put(name: string, key: StoredKey): Promise<void>;
  /** Atomically keep the existing identity or commit this candidate. Persistent
   * stores shared across contexts should implement this; no silent replacement. */
  putIfAbsent?(name: string, key: StoredKey): Promise<StoredKey>;
  delete(name: string): Promise<void>;
}

/** Keys in memory only (tests, short-lived scripts). */
export function memoryKeyStorage(): KeyStorage {
  const m = new Map<string, StoredKey>();
  return {
    get: async (n) => m.get(n),
    put: async (n, k) => void m.set(n, k),
    putIfAbsent: async (n, k) => {
      const existing = m.get(n);
      if (existing) return existing;
      m.set(n, k);
      return k;
    },
    delete: async (n) => void m.delete(n),
  };
}

/** Keys in IndexedDB (browsers, extensions, Obsidian). */
export function indexedDbKeyStorage(dbName = "mdbase-keys", storeName = "keys"): KeyStorage {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) throw mdbaseError("invalid_request", "IndexedDB is not available here; pass another KeyStorage");
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const transaction = async <T>(
    mode: IDBTransactionMode,
    work: (s: IDBObjectStore, capture: (value: T) => void) => void,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        let result: T;
        let captured = false;
        t.oncomplete = () => captured
          ? resolve(result)
          : reject(mdbaseError("unavailable", "key storage transaction completed without a result", "key_storage"));
        t.onabort = () => reject(t.error ?? mdbaseError("unavailable", "key storage transaction aborted", "key_storage"));
        t.onerror = () => reject(t.error ?? mdbaseError("unavailable", "key storage transaction failed", "key_storage"));
        try {
          work(t.objectStore(storeName), value => { result = value; captured = true; });
        } catch (error) {
          t.abort();
          reject(error);
        }
      });
    } finally {
      db.close();
    }
  };
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
    transaction<T>(mode, (s, capture) => {
      const req = fn(s);
      req.onsuccess = () => capture(req.result);
    });
  return {
    get: (n) => tx("readonly", (s) => s.get(n) as IDBRequest<StoredKey | undefined>),
    put: (n, k) => tx("readwrite", (s) => s.put(k, n)).then(() => {}),
    putIfAbsent: (n, k) => transaction<StoredKey>("readwrite", (s, capture) => {
      const req = s.get(n) as IDBRequest<StoredKey | undefined>;
      req.onsuccess = () => {
        if (req.result !== undefined) {
          capture(req.result);
          return;
        }
        try {
          const added = s.add(k, n);
          added.onsuccess = () => capture(k);
        } catch {
          s.transaction.abort();
        }
      };
    }),
    delete: (n) => tx("readwrite", (s) => s.delete(n)).then(() => {}),
  };
}

function subtle(): SubtleCrypto | undefined {
  return (globalThis as { crypto?: Crypto }).crypto?.subtle;
}

async function webCryptoX25519(): Promise<StoredKey | null> {
  const s = subtle();
  if (!s) return null;
  try {
    const pair = (await s.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const pub = new Uint8Array(await s.exportKey("raw", pair.publicKey));
    return { kind: "webcrypto", privateKey: pair.privateKey, publicKey: pub };
  } catch {
    return null; // X25519 not supported by this engine
  }
}

function toClientKey(k: StoredKey): ClientKey {
  if (k.kind === "raw") {
    return {
      publicKey: k.publicKey,
      nonExtractable: false,
      dh: (pk) => x25519.getSharedSecret(k.secretKey, pk),
    };
  }
  return {
    publicKey: k.publicKey,
    nonExtractable: !k.privateKey.extractable,
    dh: async (pk) => {
      const s = subtle()!;
      const pub = await s.importKey("raw", pk as BufferSource, { name: "X25519" }, false, []);
      const bits = await s.deriveBits({ name: "X25519", public: pub } as AlgorithmIdentifier, k.privateKey, 256);
      return new Uint8Array(bits);
    },
  };
}

export interface LoadKeyOptions {
  /** Where keys live. Default: IndexedDB when available, else memory. */
  storage?: KeyStorage;
  /** Require non-extractable X25519 custody, including for existing keys. */
  requireNonExtractable?: boolean;
}

const memoryDefault = memoryKeyStorage();
const creating = new WeakMap<KeyStorage, Map<string, Promise<StoredKey>>>();
function requireCustody(k: StoredKey, required: boolean | undefined): void {
  if (required && (
    k.kind !== "webcrypto" || k.privateKey.extractable !== false ||
    k.privateKey.type !== "private" || k.privateKey.algorithm.name !== "X25519" ||
    !k.privateKey.usages.includes("deriveBits")
  )) {
    throw mdbaseError("invalid_request", "a non-extractable X25519 key is required; explicitly reauthorize incompatible stored identities", "key_storage");
  }
}
/**
 * Load one committed identity. Existing raw/extractable keys are never silently
 * replaced when stricter custody is requested. Same-store creation coalesces;
 * built-in IndexedDB also chooses one winner across contexts atomically.
 * Custom shared persistent stores need putIfAbsent for cross-context safety.
 */
export async function loadOrCreateClientKey(name: string, o: LoadKeyOptions = {}): Promise<ClientKey> {
  const storage = o.storage ?? ((globalThis as { indexedDB?: unknown }).indexedDB ? indexedDbKeyStorage() : memoryDefault);
  const required = o.requireNonExtractable;
  let pending = creating.get(storage);
  if (!pending) {
    pending = new Map();
    creating.set(storage, pending);
  }
  let work = pending.get(name);
  if (!work) {
    work = (async () => {
      const existing = await storage.get(name);
      if (existing) return existing;
      let k = await webCryptoX25519();
      if (!k) {
        if (required) throw mdbaseError("invalid_request", "this platform cannot keep a non-extractable X25519 key", "key_storage");
        const secretKey = x25519.utils.randomSecretKey();
        k = { kind: "raw", secretKey, publicKey: x25519.getPublicKey(secretKey) };
      }
      requireCustody(k, required);
      if (storage.putIfAbsent) return storage.putIfAbsent(name, k);
      await storage.put(name, k);
      return k;
    })();
    pending.set(name, work);
  }
  try {
    const k = await work;
    // Enforce each caller's captured requirement, including the existing/atomic
    // winner and concurrent callers whose options differ from the creator's.
    requireCustody(k, required);
    return toClientKey(k);
  } finally {
    if (pending.get(name) === work) pending.delete(name);
  }
}
