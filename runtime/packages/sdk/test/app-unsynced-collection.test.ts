import {IDBFactory,IDBKeyRange} from "fake-indexeddb";
import {beforeEach,expect,it} from "vitest";
import {appUnsyncedIdentity,appUnsyncedMoved,appUnsyncedRetired,noteAppUnsyncedMoved,appUnsyncedWork,discardAppUnsynced,eraseAppUnsyncedStorage,forgetAppUnsyncedRetired,openAppUnsyncedCollection,pruneAppUnsyncedRetired,retireAppUnsynced} from "../src/app-host/unsynced-collection.js";

const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;});

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

const putRow=(name:string,key:string,value:unknown)=>new Promise<void>((resolve,reject)=>{
  const open=indexedDB.open(name,1);open.onerror=()=>reject(open.error);
  open.onsuccess=()=>{const tx=open.result.transaction("unsynced","readwrite");tx.objectStore("unsynced").put(value,key);tx.oncomplete=()=>{open.result.close();resolve();};};
});

it("reads the work marker without creating the database, and refuses a malformed one",async()=>{
  const signal=new AbortController().signal;
  expect(await appUnsyncedWork("mdbase.app.unsynced.v1",signal)).toBeNull();
  expect((await indexedDB.databases()).map(d=>d.name)).not.toContain("mdbase.app.unsynced.v1");
  await appUnsyncedIdentity("mdbase.app.unsynced.v1",true,signal);
  expect(await appUnsyncedWork("mdbase.app.unsynced.v1",signal)).toBeNull();
  await putRow("mdbase.app.unsynced.v1","work",{version:1,since:1_800_000_000_000});
  expect(await appUnsyncedWork("mdbase.app.unsynced.v1",signal)).toEqual({version:1,since:1_800_000_000_000});
  await putRow("mdbase.app.unsynced.v1","work",{version:1,since:-1});
  await expect(appUnsyncedWork("mdbase.app.unsynced.v1",signal)).rejects.toThrow("app unsynced collection");
});

it("reports no work where the browser cannot list databases",async()=>{
  const signal=new AbortController().signal;
  await appUnsyncedIdentity("listless",true,signal);await putRow("listless","work",{version:1,since:1});
  const factory=globalThis.indexedDB as {databases?:unknown};const list=factory.databases;
  try{factory.databases=undefined;expect(await appUnsyncedWork("listless",signal)).toBeNull();}finally{factory.databases=list;}
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

it("retires the current collection to the account that brought it in, so the next open starts afresh",async()=>{
  const signal=new AbortController().signal,name="retire";
  const first=(await appUnsyncedIdentity(name,true,signal))!;
  await putRow(name,"work",{version:1,since:5});
  const destination=crypto.randomUUID(),account=crypto.randomUUID();
  expect(await retireAppUnsynced(name,crypto.randomUUID(),destination,account,signal)).toBe(false);
  expect(await retireAppUnsynced(name,first.collection,destination,account,signal)).toBe(true);
  expect(await appUnsyncedWork(name,signal)).toBeNull();
  expect(await appUnsyncedIdentity(name,false,signal)).toBeNull();
  const copies=await appUnsyncedRetired(name,signal);
  expect(copies).toHaveLength(1);
  expect(copies[0]).toMatchObject({version:1,identity:first,destination,account});
  expect(copies[0]!.retiredAt).toBeGreaterThan(0);
  // Retiring twice (another tab got there first) changes nothing.
  expect(await retireAppUnsynced(name,first.collection,destination,account,signal)).toBe(false);
  const next=(await appUnsyncedIdentity(name,true,signal))!;
  expect(next.collection).not.toBe(first.collection);
  await forgetAppUnsyncedRetired(name,first.collection,signal);
  expect(await appUnsyncedRetired(name,signal)).toEqual([]);
});

it("keeps a transfer ledger for the current collection only, and drops it when the collection is retired or discarded",async()=>{
  const signal=new AbortController().signal,name="ledger",rev=(n:number)=>`sha256:${String(n).repeat(64)}`;
  const made=(await appUnsyncedIdentity(name,true,signal))!,a=crypto.randomUUID(),b=crypto.randomUUID();
  expect(await appUnsyncedMoved(name,made.collection,signal)).toEqual(new Map());
  await noteAppUnsyncedMoved(name,made.collection,new Map([[a,rev(1)]]),signal);
  await noteAppUnsyncedMoved(name,made.collection,new Map([[a,rev(2)],[b,rev(3)]]),signal);
  expect(await appUnsyncedMoved(name,made.collection,signal)).toEqual(new Map([[a,rev(2)],[b,rev(3)]]));
  // Nothing is recorded for a collection that is not the current one, or with a malformed entry.
  await expect(noteAppUnsyncedMoved(name,crypto.randomUUID(),new Map([[a,rev(1)]]),signal)).rejects.toBeInstanceOf(Error);
  await expect(noteAppUnsyncedMoved(name,made.collection,new Map([[a,"v1"]]),signal)).rejects.toBeInstanceOf(Error);
  expect(await retireAppUnsynced(name,made.collection,crypto.randomUUID(),crypto.randomUUID(),signal)).toBe(true);
  expect(await appUnsyncedMoved(name,made.collection,signal)).toEqual(new Map());
  const next=(await appUnsyncedIdentity(name,true,signal))!;
  await noteAppUnsyncedMoved(name,next.collection,new Map([[a,rev(1)]]),signal);
  expect(await discardAppUnsynced(name,next.collection,signal)).toEqual(next);
  expect(await appUnsyncedMoved(name,next.collection,signal)).toEqual(new Map());
});

it("discards only the current collection, and lists no copies without creating the database",async()=>{
  const signal=new AbortController().signal;
  expect(await appUnsyncedRetired("never",signal)).toEqual([]);
  expect((await indexedDB.databases()).map(d=>d.name)).not.toContain("never");
  const made=(await appUnsyncedIdentity("discard",true,signal))!;
  await putRow("discard","work",{version:1,since:5});
  expect(await discardAppUnsynced("discard",crypto.randomUUID(),signal)).toBeNull();
  expect(await appUnsyncedIdentity("discard",false,signal)).toEqual(made);
  expect(await discardAppUnsynced("discard",made.collection,signal)).toEqual(made);
  expect(await appUnsyncedIdentity("discard",false,signal)).toBeNull();
  expect(await appUnsyncedWork("discard",signal)).toBeNull();
  expect(await eraseAppUnsyncedStorage(made)).toBe(true);
});

it("prunes the copies it is asked to, and keeps one whose storage could not be erased",async()=>{
  const signal=new AbortController().signal,name="prune",mine=crypto.randomUUID(),theirs=crypto.randomUUID();
  const retire=async(account:string)=>{const id=(await appUnsyncedIdentity(name,true,signal))!;await retireAppUnsynced(name,id.collection,crypto.randomUUID(),account,signal);return id;};
  const a=await retire(mine),b=await retire(theirs),c=await retire(mine);
  const removed:string[]=[];
  const storage={getDirectory:async()=>({removeEntry:async(entry:string)=>{if(entry.includes(c.collection))throw new DOMException("in use","NoModificationAllowedError");removed.push(entry);}})};
  const nav=globalThis.navigator as {storage?:unknown};const before=Object.getOwnPropertyDescriptor(nav,"storage");
  Object.defineProperty(nav,"storage",{value:storage,configurable:true});
  try{expect(await pruneAppUnsyncedRetired(name,copy=>copy.account===mine,signal)).toBe(1);}
  finally{if(before)Object.defineProperty(nav,"storage",before);else delete nav.storage;}
  expect(removed).toEqual([`.mdbase-app-${a.account}-${a.installation}-${a.collection}`]);
  expect((await appUnsyncedRetired(name,signal)).map(copy=>copy.identity.collection).sort()).toEqual([b.collection,c.collection].sort());
});
