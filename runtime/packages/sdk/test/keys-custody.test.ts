import {afterEach, describe, expect, it, vi} from "vitest";
import {indexedDbKeyStorage, loadOrCreateClientKey, memoryKeyStorage, type KeyStorage, type StoredKey} from "../src/keys.js";
import {x25519} from "@noble/curves/ed25519.js";
const raw = (): StoredKey => {const secretKey=x25519.utils.randomSecretKey();return {kind:"raw",secretKey,publicKey:x25519.getPublicKey(secretKey)};};
afterEach(() => vi.unstubAllGlobals());

describe("client static key custody", () => {
  it("refuses an EXISTING raw identity without rotating or rewriting it", async () => {
    const storage=memoryKeyStorage(), existing=raw();await storage.put("key",existing);
    await expect(loadOrCreateClientKey("key",{storage,requireNonExtractable:true})).rejects.toMatchObject({code:"invalid_request"});
    expect(await storage.get("key")).toBe(existing);
    expect((await loadOrCreateClientKey("key",{storage})).nonExtractable).toBe(false);
  });
  it("loads the same nonextractable identity and performs real static DH", async () => {
    const storage=memoryKeyStorage();
    const a=await loadOrCreateClientKey("a",{storage,requireNonExtractable:true});
    const b=await loadOrCreateClientKey("b",{storage,requireNonExtractable:true});
    expect(a.nonExtractable).toBe(true);
    expect((await loadOrCreateClientKey("a",{storage,requireNonExtractable:true})).publicKey).toEqual(a.publicKey);
    expect(await a.dh(b.publicKey)).toEqual(await b.dh(a.publicKey));
    const stored=(await storage.get("a"))!;expect(stored.kind).toBe("webcrypto");
    if(stored.kind!=="webcrypto") throw Error("wrong key form");
    await expect(crypto.subtle.exportKey("pkcs8",stored.privateKey)).rejects.toThrow();
  });
  it("coalesces concurrent creation in one custom store", async () => {
    let value:StoredKey|undefined;
    const storage:KeyStorage={get:vi.fn(async()=>value),put:vi.fn(async(_n,k)=>{value=k;}),delete:async()=>{value=undefined;}};
    const keys=await Promise.all(Array.from({length:16},()=>loadOrCreateClientKey("key",{storage,requireNonExtractable:true})));
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.get).toHaveBeenCalledTimes(1);
    for(const key of keys) expect(key.publicKey).toEqual(keys[0]!.publicKey);
  });
  it("fails closed when X25519 is unsupported, without persisting a raw fallback", async () => {
    vi.stubGlobal("crypto",{subtle:{generateKey:async()=>{throw Error("unsupported");}}});
    const storage=memoryKeyStorage();
    await expect(loadOrCreateClientKey("key",{storage,requireNonExtractable:true})).rejects.toMatchObject({code:"invalid_request"});
    expect(await storage.get("key")).toBeUndefined();
  });
});

/** Manual transaction events: request-success is deliberately NOT commit. */
function manualIdb() {
  let transaction:any, request:any;
  const db={close:vi.fn(),transaction:vi.fn(()=>{
    const store:any={transaction:null,put:()=>request={result:"key"},delete:()=>request={result:undefined},get:()=>request={result:undefined},add:()=>request={result:"key"}};
    transaction={error:null,oncomplete:null,onabort:null,onerror:null,objectStore:()=>store,abort:()=>transaction.onabort?.()};store.transaction=transaction;return transaction;
  })};
  vi.stubGlobal("indexedDB",{open:()=>{const req:any={result:db};queueMicrotask(()=>req.onsuccess?.());return req;}});
  return {db,get tx(){return transaction;},get req(){return request;}};
}
describe("IndexedDB key commit barrier", () => {
  it("does not settle put/delete at request success, only transaction completion", async () => {
    for(const op of ["put","delete"] as const) {
      const idb=manualIdb(),storage=indexedDbKeyStorage();let settled=false;
      const work=op==="put"?storage.put("key",raw()):storage.delete("key");void work.then(()=>{settled=true;});
      await vi.waitFor(()=>expect(idb.req).toBeDefined());idb.req.onsuccess();await Promise.resolve();
      expect(settled).toBe(false);expect(idb.db.close).not.toHaveBeenCalled();
      idb.tx.oncomplete();await work;expect(settled).toBe(true);expect(idb.db.close).toHaveBeenCalledTimes(1);
    }
  });
  it("rejects an abort AFTER request success instead of acknowledging a committed identity", async () => {
    const idb=manualIdb(),storage=indexedDbKeyStorage();const work=storage.put("key",raw());
    const failed=expect(work).rejects.toMatchObject({code:"unavailable"});
    await vi.waitFor(()=>expect(idb.req).toBeDefined());idb.req.onsuccess();idb.tx.onabort();await failed;
    expect(idb.db.close).toHaveBeenCalledTimes(1);
  });
  it("atomic creation keeps an existing winner and waits for commit", async () => {
    const idb=manualIdb(),storage=indexedDbKeyStorage(),existing=raw();let settled=false;
    const work=storage.putIfAbsent!("key",raw());void work.then(()=>{settled=true;});
    await vi.waitFor(()=>expect(idb.req).toBeDefined());idb.req.result=existing;idb.req.onsuccess();await Promise.resolve();
    expect(settled).toBe(false);idb.tx.oncomplete();expect(await work).toBe(existing);
  });
});
