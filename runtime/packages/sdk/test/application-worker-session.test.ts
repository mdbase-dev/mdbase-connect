import {afterEach,describe,expect,it,vi} from "vitest";
import {AppWebSignInSession} from "../src/app-host/web-sign-in-session.js";
import {AppScopedSignInSession} from "../src/app-host/scoped-sign-in-session.js";
import {applicationStorageOwner} from "../src/application/storage-scope.js";
import {applicationDeclaration,rebindApplicationDeclaration} from "../src/application/declaration.js";
import {applicationWorkerSession} from "../src/application/worker-session.js";
import type {PackagedApplicationNativeAssets} from "../src/application/native-assets.js";
const id="5cdfa020-c201-4da8-845a-f2cc9969eade",origin="https://app.test",cpOrigin="https://cp.test";
afterEach(()=>vi.unstubAllGlobals());
function declaration(){return applicationDeclaration({id,name:"TaskNotes",origin,environment:"production",manifest:{manifest_version:1,id:"dev.example.tasknotes",name:"TaskNotes",homepage:origin,redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"],optional:[]}}},storage:{joinDatabaseName:"retained.join.v1",setupDatabaseName:"retained.setup.v1",applicationNamespace:"retained-namespace"}});}
// Declared packaging/initializer/transport fixture: not signed asset
// authentication, native/SQLite/OPFS, account enrollment or browser acceptance.
function packaged():PackagedApplicationNativeAssets{return{
  release:()=>({schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin:"https://log.test",assetSha256:"a".repeat(64),source:{repository:"mdbase-dev/mdbase-connect",commit:"b".repeat(40),version:"fixture"},trustedRoots:[new Uint8Array(32).fill(1)],policyPins:new Uint8Array([1,2,3])}),
  runtime:{url:`${origin}/native/app.wasm`,sha256:"c".repeat(64),bytes:4,maxBytes:3300000},sqlite:{url:`${origin}/native/sqlite.wasm`,sha256:"d".repeat(64),bytes:4,maxBytes:1100000},initializeSqlite:vi.fn(),
};}
describe("SDK-private original Worker session composition",()=>{
  it("keeps the default owner after a superseded registration preserves old storage names",async()=>{
    const {storage:_storage,...input}=declaration();const original=applicationDeclaration(input);
    const rebound=rebindApplicationDeclaration(original,{id:"77777777-7777-4777-8777-777777777777",name:"TaskNotes",supersededDeclaredId:id});
    const result=applicationWorkerSession(rebound,packaged(),{signal:new AbortController().signal,locks:undefined,storageNamespace:null,openPortal:()=>({navigate:vi.fn(),close:vi.fn()}),handoff:vi.fn()});
    try{
      const options=(result.session as unknown as {options:{owner:string;storageNamespace?:string}}).options;
      expect(options.owner).toBe("bundle:dev.example.tasknotes");expect(options).not.toHaveProperty("storageNamespace");
      expect(result.collection.joinDatabaseName).toBe(`mdbase.${id}.native-collection-join.v1`);
    }finally{await result.session.close();}
  });
  it("composes actual lifecycle without startup IO/identities/second UI client or app loader",async()=>{
    const p=packaged(),fetcher=vi.fn(),handoff=vi.fn(),openPortal=vi.fn(()=>({navigate:vi.fn(),close:vi.fn()})),caller=new AbortController();
    const uuid=vi.spyOn(crypto,"randomUUID"),result=applicationWorkerSession(declaration(),p,{signal:caller.signal,locks:undefined,storageNamespace:"retained-namespace",fetch:fetcher,handoff,openPortal});
    try{
      expect(result.session).toBeInstanceOf(AppScopedSignInSession);expect(result.session.original).toBeInstanceOf(AppWebSignInSession);expect(result.session.getSnapshot()).toMatchObject({status:"not_started",signIn:null,selectedCollectionId:null});
      expect(result.compiled.nativeCapabilities).toEqual({capabilityContractVersion:2,requiredNativeCapabilities:["collection.read"]});
      // The local slot owner is the declaration's manifest family, not the CP appId.
      expect((result.session as unknown as {options:{appId:string;owner:string}}).options).toMatchObject({appId:id,owner:applicationStorageOwner("dev.example.tasknotes","retained-namespace"),storageNamespace:"retained-namespace",freshRequestedCreateCollections:true});
      expect((result.session as unknown as {options:object}).options).not.toHaveProperty("requestedCreateCollections");
      expect(result.collection.people).toBe(true);expect(result.collection.joinDatabaseName).toBe("retained.join.v1");
      expect(result.collection.setupJournal).toEqual({databaseName:"retained.setup.v1",applicationNamespace:"retained-namespace",appOrigin:origin,cpOrigin});
      expect(result.collection.sql.initialize).toBe(p.initializeSqlite);expect(fetcher).not.toHaveBeenCalled();expect(openPortal).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();expect(uuid).not.toHaveBeenCalled();expect(p.initializeSqlite).not.toHaveBeenCalled();
      expect(result.session.connection()).toBeNull();expect(Object.isFrozen(result.compiled.manifest)).toBe(true);
    }finally{uuid.mockRestore();await result.session.close();}
  });
  it("fences original caller before packaging access and after a late synchronous packaging callback",()=>{
    const p=packaged(),release=vi.spyOn(p,"release"),caller=new AbortController(),host={signal:caller.signal,locks:undefined,storageNamespace:"retained-namespace",openPortal:()=>({navigate:vi.fn(),close:vi.fn()}),handoff:vi.fn()};
    caller.abort();expect(()=>applicationWorkerSession(declaration(),p,host)).toThrow();expect(release).not.toHaveBeenCalled();
    const late=new AbortController(),original=packaged().release;release.mockImplementation(()=>{late.abort();return original();});
    expect(()=>applicationWorkerSession(declaration(),p,{...host,signal:late.signal})).toThrow();expect(host.handoff).not.toHaveBeenCalled();
  });
  it("resnapshots a mutable Worker clone before invoking packaging callbacks",async()=>{
    const mutable={...declaration(),storage:{...declaration().storage}},p=packaged(),original=p.release;
    p.release=()=>{mutable.origin="https://replacement.test";mutable.storage.applicationNamespace="replacement";return original();};
    const result=applicationWorkerSession(mutable,p,{signal:new AbortController().signal,locks:undefined,storageNamespace:"retained-namespace",openPortal:()=>({navigate:vi.fn(),close:vi.fn()}),handoff:vi.fn()});
    try{expect(result.collection.setupJournal.appOrigin).toBe(origin);expect(result.collection.setupJournal.applicationNamespace).toBe("retained-namespace");expect(result.session.getSnapshot().status).toBe("not_started");}finally{await result.session.close();}
  });
  it("refuses malformed manifest/context instead of native bootstrap, fake READY or substituted environment",()=>{
    const caller=new AbortController(),p=packaged(),host={signal:caller.signal,locks:undefined,storageNamespace:"retained-namespace",openPortal:()=>({navigate:vi.fn(),close:vi.fn()}),handoff:vi.fn()};
    expect(()=>applicationWorkerSession({...declaration(),manifest:{unexpected:"invalid"}},p,host)).toThrow();
    expect(()=>applicationWorkerSession({...declaration(),environment:"lab"},p,host)).toThrow();expect(host.handoff).not.toHaveBeenCalled();expect(p.initializeSqlite).not.toHaveBeenCalled();
  });
});
