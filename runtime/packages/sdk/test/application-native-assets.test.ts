import {describe,expect,it,vi} from "vitest";
import {applicationDeclaration} from "../src/application/declaration.js";
import {applicationNativeAssets,type PackagedApplicationNativeAssets} from "../src/application/native-assets.js";
import type {AppBundledReleaseTrust} from "../src/app-host/cloud-copy-bootstrap.js";
const origin="https://app.test",cpOrigin="https://cp.test",logOrigin="https://log.test";
// Explicit trust/initializer ports: these tests do NOT authenticate a release or
// instantiate native/SQLite/OPFS. Actual WebCrypto checks transport integrity.
const release=():AppBundledReleaseTrust=>({schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin,assetSha256:"a".repeat(64),source:{repository:"mdbase-dev/mdbase-connect",commit:"b".repeat(40),version:"test.1"},trustedRoots:[new Uint8Array(32).fill(1)],policyPins:new Uint8Array([1,2,3])});
const declaration=()=>applicationDeclaration({id:"11111111-1111-4111-8111-111111111111",name:"Example",origin,environment:"production",manifest:{id:"dev.example.app"},storage:{joinDatabaseName:"retained.original.join.v1",setupDatabaseName:"retained.original.setup.v1",applicationNamespace:"original-namespace"}});
async function bundle():Promise<PackagedApplicationNativeAssets>{const bytes=new Uint8Array([0,97,115,109]),hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),sha256=Array.from(hash,x=>x.toString(16).padStart(2,"0")).join("");return{release,runtime:{url:`${origin}/assets/native.wasm`,sha256,bytes:4,maxBytes:3300000},sqlite:{url:`${origin}/assets/sqlite.wasm`,sha256,bytes:4,maxBytes:1100000},initializeSqlite:vi.fn()};}
describe("SDK-private native assets composition, not an app callback/declaration surface",()=>{
  it("owns native/SQL loaders and passes exact original journal/namespace compatibility data",async()=>{
    const packaged=await bundle(),handoff=vi.fn(),fetcher=vi.fn(async()=>new Response(new Uint8Array([0,97,115,109]))),native=applicationNativeAssets(declaration(),packaged,handoff,fetcher);
    expect(native.collection.joinDatabaseName).toBe("retained.original.join.v1");expect(native.collection.setupJournal).toEqual({databaseName:"retained.original.setup.v1",applicationNamespace:"original-namespace",appOrigin:origin,cpOrigin});expect(native.collection.handoff).toBe(handoff);
    const caller=new AbortController().signal;expect(await native.loadRuntime({signal:caller})).toEqual(new Uint8Array([0,97,115,109]));expect(await native.collection.sql.loadWasm({signal:caller})).toEqual(new Uint8Array([0,97,115,109]));expect(fetcher).toHaveBeenCalledTimes(2);expect(packaged.initializeSqlite).not.toHaveBeenCalled();expect(native.collection.sql.initialize).toBe(packaged.initializeSqlite);
    expect(native.release.assetSha256).toBe("a".repeat(64));expect(native.collection.sql.wasmSha256).not.toBe(native.release.assetSha256);expect(native.environment.logOrigin).toBe(logOrigin);
  });
  it("uses only canonical authenticated environment selection, never fallback",async()=>{
    const packaged=await bundle(),fetcher=vi.fn();expect(()=>applicationNativeAssets({...declaration(),environment:"lab"},packaged,vi.fn(),fetcher)).toThrow("explicit authenticated build context");expect(fetcher).not.toHaveBeenCalled();expect(packaged.initializeSqlite).not.toHaveBeenCalled();
  });
  it("retains independent original trust provenance/owned byte buffers instead of rewriting it to SDK HEAD",async()=>{
    const original=release(),packaged={...await bundle(),release:()=>original},native=applicationNativeAssets(declaration(),packaged,vi.fn());
    original.trustedRoots[0]!.fill(8);original.policyPins.fill(9);expect(native.release.trustedRoots[0]).toEqual(new Uint8Array(32).fill(1));expect(native.release.policyPins).toEqual(new Uint8Array([1,2,3]));expect(native.release.source.commit).toBe("b".repeat(40));expect(Object.isFrozen(native.collection.setupJournal)).toBe(true);
  });
  it("rejects malformed SDK asset binding before any IO/initializer/handoff",async()=>{
    const packaged=await bundle(),fetcher=vi.fn(),handoff=vi.fn();expect(()=>applicationNativeAssets(declaration(),{...packaged,sqlite:{...packaged.sqlite,url:"https://foreign.test/sqlite.wasm"}},handoff,fetcher)).toThrow("application asset");expect(fetcher).not.toHaveBeenCalled();expect(handoff).not.toHaveBeenCalled();expect(packaged.initializeSqlite).not.toHaveBeenCalled();
  });
});
