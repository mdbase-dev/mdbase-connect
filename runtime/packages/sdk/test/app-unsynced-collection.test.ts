import {IDBFactory} from "fake-indexeddb";
import {beforeEach,expect,it} from "vitest";
import {appUnsyncedIdentity,openAppUnsyncedCollection} from "../src/app-host/unsynced-collection.js";

const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();});

it("creates one identity per storage scope, keeps it, and never creates on read",async()=>{
  const signal=new AbortController().signal;
  expect(await appUnsyncedIdentity("mdbase.app.unsynced.v1",false,signal)).toBeNull();
  const made=await appUnsyncedIdentity("mdbase.app.unsynced.v1",true,signal);
  expect(made).not.toBeNull();
  const ids=[made!.account,made!.installation,made!.collection,made!.replica,made!.device];
  expect(ids.every(id=>uuid.test(id))).toBe(true);expect(new Set(ids).size).toBe(5);
  expect(await appUnsyncedIdentity("mdbase.app.unsynced.v1",true,signal)).toEqual(made);
  expect(await appUnsyncedIdentity("mdbase.app.unsynced.v1",false,signal)).toEqual(made);
  // Another app storage scope has its own.
  expect((await appUnsyncedIdentity("mdbase.other.unsynced.v1",true,signal))!.collection).not.toBe(made!.collection);
});

it("two Workers racing to create agree on one collection",async()=>{
  const signal=new AbortController().signal;
  const [a,b]=await Promise.all([appUnsyncedIdentity("race",true,signal),appUnsyncedIdentity("race",true,signal)]);
  expect(a).toEqual(b);
});

it("refuses a malformed stored identity instead of replacing it",async()=>{
  const signal=new AbortController().signal;
  await appUnsyncedIdentity("bad",false,signal);
  await new Promise<void>((resolve,reject)=>{
    const open=indexedDB.open("bad",1);open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{const tx=open.result.transaction("unsynced","readwrite");tx.objectStore("unsynced").put({version:1,collection:"x"},"current");tx.oncomplete=()=>{open.result.close();resolve();};};
  });
  await expect(appUnsyncedIdentity("bad",true,signal)).rejects.toThrow("app unsynced collection");
});

it("refuses an aborted open before touching storage",async()=>{
  const stop=new AbortController();stop.abort();
  await expect(appUnsyncedIdentity("aborted",true,stop.signal)).rejects.toThrow();
  await expect(openAppUnsyncedCollection({databaseName:"x",setupJournal:{databaseName:"s",applicationNamespace:"n",appOrigin:"https://app.test",cpOrigin:"https://cp.test"},
    sql:{wasmSha256:"0".repeat(64),maxWasmBytes:1,loadWasm:async()=>new Uint8Array(),initialize:async()=>({})},locks:undefined,loadRuntime:async()=>new Uint8Array()},"App",stop.signal)).rejects.toThrow();
});
