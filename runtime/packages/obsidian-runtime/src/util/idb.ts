/**
 * Small promise helpers over IndexedDB. Every database this package opens is
 * named per collection (all plugins and vault windows of one Obsidian
 * profile share the origin).
 */

/** Open (or create) `name` at `version`, creating `stores` on upgrade. */
export function openDb(name: string, version: number, stores: readonly string[], idb: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(name, version);
    r.onupgradeneeded = () => {
      for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another context upgraded the schema: close so it is not blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(`IndexedDB ${name} open blocked`));
  });
}

/**
 * Run `fn` in one transaction and resolve when it **commits** (not when the
 * requests succeed). `strict` asks for `durability: "strict"`, requesting stronger
 * persistence without claiming independently qualified physical power-loss safety.
 */
export function tx<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => T,
  strict = mode === "readwrite",
): Promise<T> {
  return new Promise((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(stores, mode, strict ? { durability: "strict" } : undefined);
    } catch (e) {
      reject(e);
      return;
    }
    let out: T;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
    try {
      out = fn(t);
    } catch (e) {
      try {
        t.abort();
      } catch {
        /* already finished */
      }
      reject(e);
    }
  });
}

/** Resolve an `IDBRequest` (for reads inside {@link tx}). */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** True for a quota error (treat as "rebuild/compact", not "disk full", quota handling). */
export function isQuotaError(e: unknown): boolean {
  return e instanceof Error && (e.name === "QuotaExceededError" || /quota/i.test(e.message));
}
