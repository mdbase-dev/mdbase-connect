/**
 * P5: the last log token per device and collection, so a reload reuses it
 * until shortly before it expires instead of minting one (a challenge and a
 * mint, two CP round trips) on every open. The token is no more powerful than
 * the device key beside it in this origin's storage, which can mint one; RPCs
 * are still signed per request. A refused token is dropped; signing out deletes
 * its scoped records (legacy default sign-out deletes the database).
 */
export const LOG_TOKEN_DATABASE = "mdbase.app.log-token.v1";
const STORE = "tokens";
/** Reuse a stored token only with at least this much lifetime left. */
const MIN_LEFT_MS = 60_000;

export interface AppLogToken { readonly value: string; readonly expires: number }
export interface AppLogTokenCache {
  read(key: string, now: number): Promise<AppLogToken | null>;
  write(key: string, token: AppLogToken): Promise<void>;
  drop(key: string): Promise<void>;
}

function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(LOG_TOKEN_DATABASE, 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => { try { request.result.createObjectStore(STORE); } catch { /* resolved as unusable below */ } };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close(); // sign-out deletes it
      resolve(db.objectStoreNames.contains(STORE) ? db : (db.close(), null));
    };
    request.onerror = request.onblocked = () => resolve(null);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return open().then(db => new Promise<T | null>(resolve => {
    if (!db) { resolve(null); return; }
    let result: T | null = null;
    try {
      const tx = db.transaction(STORE, mode), request = work(tx.objectStore(STORE));
      if (request) request.onsuccess = () => { result = request.result ?? null; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
    } catch { db.close(); resolve(null); }
  }));
}

/** IndexedDB-backed cache; every failure is a miss (mint as before). */
export function idbLogTokenCache(): AppLogTokenCache | null {
  if (typeof indexedDB === "undefined") return null;
  return Object.freeze({
    async read(key: string, now: number) {
      const v = await run<unknown>("readonly", store => store.get(key)).catch(() => null) as { value?: unknown; expires?: unknown } | null;
      if (!v || typeof v.value !== "string" || !v.value || v.value.length > 16 * 1024 || /[^\x21-\x7e]/.test(v.value)
        || typeof v.expires !== "number" || !Number.isSafeInteger(v.expires) || v.expires - now < MIN_LEFT_MS || v.expires - now > 16 * 60_000) return null;
      return Object.freeze({ value: v.value, expires: v.expires });
    },
    async write(key: string, token: AppLogToken) { await run("readwrite", store => store.put({ value: token.value, expires: token.expires }, key)).catch(() => null); },
    async drop(key: string) { await run("readwrite", store => store.delete(key)).catch(() => null); },
  });
}

/** Remove only this installation's device tokens, including unlisted collections
 * and earlier log origins. A pre-pairing slot has no device tokens to erase.
 * Match the exact CP/connector/device tuple written by AppCpLogAuthority. */
export async function eraseAppLogTokens(scope: {readonly cpOrigin:string;readonly connectorId:string|null;readonly deviceId:string|null}):Promise<boolean> {
  const {cpOrigin,connectorId,deviceId}=scope;
  if(!connectorId||!deviceId)return true;
  const db=await open();
  if(!db)return false;
  return new Promise<boolean>(resolve=>{
    try {
      const tx=db.transaction(STORE,"readwrite"),cursor=tx.objectStore(STORE).openCursor();
      cursor.onsuccess=()=>{
        const row=cursor.result;if(!row)return;
        if(typeof row.key==="string"){
          const parts=row.key.split(" ");
          if(parts.length===5&&parts[0]===cpOrigin&&parts[2]===connectorId&&parts[3]===deviceId)row.delete();
        }
        row.continue();
      };
      tx.oncomplete=()=>{db.close();resolve(true);};
      tx.onerror=tx.onabort=()=>{db.close();resolve(false);};
    }catch{db.close();resolve(false);}
  });
}
