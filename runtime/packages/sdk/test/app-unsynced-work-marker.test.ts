import {IDBFactory,IDBKeyRange} from "fake-indexeddb";
import {beforeEach,expect,it,vi} from "vitest";
import type {AppCollectionSetupTurn} from "../src/app-host/collection-control.js";

// The replica's SQL, runtime and lease stand in: this checks only when the
// unsynced collection marks itself as holding work.
const seen=vi.hoisted(()=>({source:null as string | null, put:vi.fn(),logWork:null as ((method:string)=>void)|null,setupTurn:null as AppCollectionSetupTurn|null}));
vi.mock("../src/app-storage/collection-sql.js",()=>({createAppCollectionSql:()=>async()=>({sql:{fence(){}},close:async()=>{},opened:"fresh",sqliteVersion:"3"})}));
vi.mock("../src/app-host/wasm-runtime.js",()=>({AppWasmRuntime:{create:async()=>({openUnsyncedConsuming(){},tick(){},close:async()=>true})}}));
vi.mock("../src/app-host/owner.js",()=>({acquireAppReplicaLease:async()=>({release:async()=>{}})}));
vi.mock("../src/app-host/collection-setup-journal.js",()=>({AppCollectionSetupJournal:class{async load(){return null;}close(){}}}));
vi.mock("../src/app-host/local-facade.js",()=>({attachAppLocalFacade:(_runtime:unknown,_port:unknown,_scope:unknown,logWork:(method:string)=>void)=>{seen.logWork=logWork;return {close(){},resourceSetup:{}};}}));
vi.mock("../src/app-host/collection-control.js",()=>({attachAppCollectionControl:(_port:unknown,_binding:unknown,options:{setupTurn:AppCollectionSetupTurn})=>{seen.setupTurn=options.setupTurn;return {close:async()=>{}};}}));

vi.mock("../src/client.js",()=>({MdbaseClient:{connect:async()=>({
  resources:{
    async get(){if(seen.source===null)throw mdbaseError("not_found","no config");return {text:seen.source,state:"confirmed"};},
    async put(path:string,doc:string,options:unknown){seen.put(path,doc,options);seen.source=doc;return {confirmed:Promise.resolve()};},
  },
  async receipt(){throw mdbaseError("not_found","no receipt");},
  close(){},
})}}));
const {mdbaseError}=await import("../src/errors.js");
const {appUnsyncedWork,openAppUnsyncedCollection}=await import("../src/app-host/unsynced-collection.js");
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;seen.source=null;seen.put.mockClear();});

it("setup's own submit is not work; the person's first submit is",async()=>{
  const signal=new AbortController().signal,name="marker";
  const connection=await openAppUnsyncedCollection({databaseName:name,setupJournal:{} as never,sql:{} as never,locks:undefined,loadRuntime:async()=>new Uint8Array()},"TaskNotes",signal);
  expect(connection.attach()).not.toBeNull();
  const settled=()=>new Promise(resolve=>setTimeout(resolve,20));
  // Automatic setup on first open submits the app's definitions under a setup turn.
  seen.setupTurn!.owner={};
  seen.logWork!("submit");await settled();
  seen.setupTurn!.owner=null;
  expect(connection.work).toBeNull();
  expect(await appUnsyncedWork(name,signal)).toBeNull();
  expect(connection.writes).toBe(1);
  // Reads are not work either.
  seen.logWork!("read_file");await settled();
  expect(await appUnsyncedWork(name,signal)).toBeNull();
  // The person saves something.
  seen.logWork!("submit");await settled();
  expect(connection.work).toEqual({version:1,since:expect.any(Number)});
  expect(await appUnsyncedWork(name,signal)).toEqual(connection.work);
  await connection.close();
});

it("writes a create-only config and keeps existing configs byte-for-byte on reopen", async () => {
  const signal = new AbortController().signal;
  const options = {databaseName:"config",setupJournal:{} as never,sql:{} as never,locks:undefined,loadRuntime:async()=>new Uint8Array()};
  const first = await openAppUnsyncedCollection(options, "Notes", signal, "Australia/Melbourne");
  expect(seen.put).toHaveBeenCalledWith("mdbase.yaml", 'spec_version: "0.3.0"\nsettings:\n  timezone: "Australia/Melbourne"\n',
    expect.objectContaining({mustNotExist:true, mutationId:first.scope.collection}));
  expect(first.work).toBeNull();
  await first.close();
  seen.source = 'spec_version: "0.3.0"\n# Existing config without a time zone\n';
  const reopened = await openAppUnsyncedCollection(options, "Notes", signal, "Europe/London");
  expect(seen.put).toHaveBeenCalledTimes(1);
  expect(seen.source).toBe('spec_version: "0.3.0"\n# Existing config without a time zone\n');
  await reopened.close();
});

it("creates a valid config without a time zone when detection is unusable", async () => {
  const connection = await openAppUnsyncedCollection({
    databaseName:"config",setupJournal:{} as never,sql:{} as never,locks:undefined,loadRuntime:async()=>new Uint8Array(),
  }, "Notes", new AbortController().signal, "local");
  expect(seen.source).toBe('spec_version: "0.3.0"\n');
  await connection.close();
});
