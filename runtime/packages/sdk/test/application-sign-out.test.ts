import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";

// UX-011 sign-out through the real entry and runtime, with a scripted
// application Worker (the Worker session's erase order is in web-sign-in-session.test.ts).
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {MdbaseConnect}=await import("../src/application/entry.js");
const {createMdbase}=await import("../src/application/front-door.js");

const origin="https://app.test",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const signIn={requestId:"r1",installationId:"i1",deviceId:"d1",appId:"p1",kind:"app-runtime",verificationUri:"https://cp.test/pair",state:"paired",accountId:"acct-1",
  collectionIds:[A,B],createCollections:false,requestedCreateCollections:false};
const paired={status:"unselected",signIn,collections:[{collectionId:A,displayName:"A",role:"owner"},{collectionId:B,displayName:"B",role:"owner"}],selectedCollectionId:null,problem:null,timing:null};
const signedOut={status:"signed_out",signIn:null,collections:[],selectedCollectionId:null,problem:null,timing:null};

class FakeWorker {
  static all:FakeWorker[]=[];static snapshot:unknown=paired;
  readonly terminate=vi.fn();readonly requests:unknown[][]=[];bootstrap:unknown[]=[];port:MessagePort|null=null;binding="";
  constructor(){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  postMessage(message:unknown[],transfer:MessagePort[]){
    this.bootstrap=message;this.binding=message[1] as string;const port=transfer[0]!;this.port=port;
    port.addEventListener("message",event=>{
      const request=event.data as unknown[],action=request[3];if(action==="foreground")return;
      this.requests.push(request);
      const snapshot=action==="close"?{...signedOut,status:"closed"}:action==="signOut"?{...signedOut,signOutResult:{server:"revoked",local:"erased",webPush:false}}:FakeWorker.snapshot;
      port.postMessage([schema,this.binding,"reply",request[2],{ok:true,snapshot}]);
    });port.start();
  }
}
const store=new Map<string,string>();
const localStorage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
const actions=()=>FakeWorker.all.flatMap(w=>w.requests.map(r=>r[3]));
const page=(href=`${origin}/`,storage?:{applicationNamespace:string})=>{
  const next=Object.assign(new EventTarget(),{location:{origin,href},history:{state:null,pushState(){},replaceState(){}}});
  vi.stubGlobal("window",next);vi.stubGlobal("location",next.location);
  const entry=new MdbaseConnect({...declaration,...(storage?{storage}:{})});return {entry,app:entry.application()};
};
beforeEach(()=>{FakeWorker.all=[];FakeWorker.snapshot=paired;store.clear();vi.stubGlobal("Worker",FakeWorker);vi.stubGlobal("localStorage",localStorage);
  // A browser page also has locks, storage and IndexedDB (entry capability probe).
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

describe("front door additions",()=>{
  it("refreshCollectionList re-reads the approved list; reauthorize and configure are on the front door",async()=>{
    page();const mdbase=createMdbase(declaration);await mdbase.start();
    expect((await mdbase.refreshCollectionList()).status).toBe("unselected");
    expect(actions()).toContain("refreshCollections");
    expect(mdbase.reauthorize).toBeTypeOf("function");expect(mdbase.configure).toBeTypeOf("function");
    await mdbase.close();
  });
  it("asks for persistent storage at app start, before sign-in, and reports the policy on the snapshot",async()=>{
    const persist=vi.fn(async()=>true);
    vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist}});
    const {app:mdbase}=page();
    await vi.waitFor(()=>expect(persist).toHaveBeenCalledOnce());
    expect(actions()).toEqual([]);
    await mdbase.start();await mdbase.refreshCollectionList!();expect(persist).toHaveBeenCalledOnce();
    await vi.waitFor(()=>expect(mdbase.getSnapshot().storage).toEqual({persistent:true,installed:false}));
    expect(mdbase.getSnapshot().saveWarning).toBeNull();
    await mdbase.close();
  });
});
describe("sign out (UX-011)",()=>{
  it("binds namespace before registration and sends it only for an override",async()=>{
    const a=page(`${origin}/`,{applicationNamespace:"vault-a"});await a.app.start();
    expect(FakeWorker.all[0]!.bootstrap[3]).toBe("vault-a");
    const b=page();await b.app.start();
    expect(FakeWorker.all[1]!.bootstrap).toHaveLength(3);
    expect((FakeWorker.all[1]!.bootstrap[2] as {storage:{applicationNamespace:string}}).storage.applicationNamespace).toBe("55555555-5555-4555-8555-555555555555");
    await a.app.close();await b.app.close();
  });
  it("signs out, drops the Worker and this page's storage; the next start uses a fresh Worker",async()=>{
    const {app}=page();await app.start();await app.forget(B);
    expect([...store.keys()].some(k=>k.startsWith("mdbase.org.example.app."))).toBe(true);
    const out=await app.signOut!();
    expect(out).toMatchObject({status:"signed_out",signIn:null,collections:[],selectedCollectionId:null,problem:null,phase:{kind:"signed_out",notice:null}});
    expect(actions()).toEqual(["start","signOut","close"]);expect(FakeWorker.all[0]!.terminate).toHaveBeenCalledOnce();
    expect([...store.keys()].filter(k=>k.startsWith("mdbase.org.example.app."))).toEqual([]);
    FakeWorker.snapshot={...signedOut,signIn:{...signIn,state:"pending",accountId:null}};
    expect((await app.start()).status).toBe("signed_out");
    expect(FakeWorker.all).toHaveLength(2);expect(FakeWorker.all[1]!.requests.map(r=>r[3])).toEqual(["start"]);
  });
  it("refuses while writes are unconfirmed, erasing nothing; discard signs out anyway",async()=>{
    vi.spyOn(console,"error").mockImplementation(()=>{});
    FakeWorker.snapshot={...paired,status:"ready",selectedCollectionId:A};
    const {entry,app}=page(`${origin}/?collection=${A}`);await app.start();
    const scope=(entry as unknown as {runtime:{scope:{connection:(id:string)=>unknown}}}).runtime.scope;
    // The count is the larger of the replica's pending count and the write ledger's.
    scope.connection=id=>id===A?{records:{status:{pending:2},ledger:{getSnapshot:()=>({pending:[1,2,3]})}}}:null;
    await expect(app.signOut!()).rejects.toMatchObject({code:"conflict",reason:"sign_out_pending_writes",details:3,message:expect.stringContaining("3 changes")});
    expect(actions()).not.toContain("signOut");expect(FakeWorker.all[0]!.terminate).not.toHaveBeenCalled();
    expect((await app.signOut!({discard:true})).status).toBe("signed_out");expect(actions()).toContain("signOut");
  });
});
