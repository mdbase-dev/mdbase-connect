import {IDBFactory,IDBKeyRange} from "fake-indexeddb";
import {beforeEach,expect,it,vi} from "vitest";
import type {AppCollectionSetupTurn} from "../src/app-host/collection-control.js";

// The replica's SQL, runtime and lease stand in: this checks only when the
// unsynced collection marks itself as holding work.
const seen=vi.hoisted(()=>({logWork:null as ((method:string)=>void)|null,setupTurn:null as AppCollectionSetupTurn|null}));
vi.mock("../src/app-storage/collection-sql.js",()=>({createAppCollectionSql:()=>async()=>({sql:{fence(){}},close:async()=>{},opened:"fresh",sqliteVersion:"3"})}));
vi.mock("../src/app-host/wasm-runtime.js",()=>({AppWasmRuntime:{create:async()=>({openUnsyncedConsuming(){},tick(){},close:async()=>true})}}));
vi.mock("../src/app-host/owner.js",()=>({acquireAppReplicaLease:async()=>({release:async()=>{}})}));
vi.mock("../src/app-host/collection-setup-journal.js",()=>({AppCollectionSetupJournal:class{async load(){return null;}close(){}}}));
vi.mock("../src/app-host/local-facade.js",()=>({attachAppLocalFacade:(_runtime:unknown,_port:unknown,_scope:unknown,logWork:(method:string)=>void)=>{seen.logWork=logWork;return {close(){},resourceSetup:{}};}}));
vi.mock("../src/app-host/collection-control.js",()=>({attachAppCollectionControl:(_port:unknown,_binding:unknown,options:{setupTurn:AppCollectionSetupTurn})=>{seen.setupTurn=options.setupTurn;return {close:async()=>{}};}}));

const {appUnsyncedWork,openAppUnsyncedCollection}=await import("../src/app-host/unsynced-collection.js");
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;});

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
