import { directBackendOrigin } from "./direct-origin.js";
import { directCredential } from "./direct-credential.js";
import { mdbaseError } from "./errors.js";

export interface DirectBrowserGrant { readonly server: string; readonly token: string; readonly receipt?: string }
export interface DirectGrantStore {
  read(): Promise<DirectBrowserGrant | undefined>;
  save(grant: DirectBrowserGrant): Promise<string>;
  forget(receipt?: string): Promise<void>;
}

interface SealedGrant { server: string; receipt: string; key: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }

export function createDirectGrantStore(name: string): DirectGrantStore {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(name)) throw mdbaseError("invalid_request", "Invalid browser grant store name");
  const database = `mdbase-direct:${name}`;
  const encoded = (value: string) => new TextEncoder().encode(value);
  const aad = (server: string, receipt: string) => encoded(JSON.stringify([database, location.origin, server, receipt]));
  async function access<T>(mode: IDBTransactionMode, run: (table: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("grant");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("grant", mode);
        let result: T;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? mdbaseError("unavailable", "Browser storage transaction aborted"));
        run(tx.objectStore("grant"), value => { result = value; });
      });
    } finally { db.close(); }
  }
  return {
    async read() {
      const saved = await access<SealedGrant | undefined>("readonly", (table, set) => {
        const request = table.get("browser");
        request.onsuccess = () => set(request.result);
      });
      if (!saved) return;
      const server = directBackendOrigin(saved.server);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: saved.iv, additionalData: aad(server, saved.receipt) }, saved.key, saved.ciphertext);
      const token = new TextDecoder().decode(plaintext);
      directCredential(server, token);
      return { server, token, receipt: saved.receipt };
    },
    async save(grant) {
      const server = directBackendOrigin(grant.server);
      const token = grant.token;
      directCredential(server, token);
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12)), receipt = crypto.randomUUID();
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(server, receipt) }, key, encoded(token));
      await access<void>("readwrite", table => { table.add({ server, receipt, key, iv, ciphertext } satisfies SealedGrant, "browser"); });
      return receipt;
    },
    async forget(receipt) {
      await access<void>("readwrite", table => {
        if (receipt === undefined) { table.delete("browser"); return; }
        const request = table.get("browser");
        request.onsuccess = () => { if (request.result?.receipt === receipt) table.delete("browser"); };
      });
    },
  };
}
