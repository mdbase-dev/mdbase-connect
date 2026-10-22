import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";

// SDK-2 (refresh on focus, no polling) and SDK-3 (forget survives a reload)
// against the real entry and runtime, with a scripted application Worker.
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {MdbaseConnect}=await import("../src/application/entry.js");

const origin="https://app.test",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const signIn={requestId:"r1",installationId:"i1",deviceId:"d1",appId:"p1",kind:"app-runtime",verificationUri:"https://cp.test/pair",state:"paired",accountId:"acct-1",
  collectionIds:[A,B],createCollections:false,requestedCreateCollections:false};
const paired={status:"unselected",signIn,collections:[{collectionId:A,displayName:"A",role:"owner"},{collectionId:B,displayName:"B",role:"owner"}],selectedCollectionId:null,problem:null,timing:null};

class FakeWorker {
  static all:FakeWorker[]=[];static snapshot:unknown=paired;
  readonly terminate=vi.fn();readonly requests:unknown[][]=[];port:MessagePort|null=null;binding="";
  constructor(){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  postMessage(message:unknown[],transfer:MessagePort[]){
    this.binding=message[1] as string;const port=transfer[0]!;this.port=port;
    port.addEventListener("message",event=>{
      const request=event.data as unknown[];if(request[3]==="foreground")return;
      this.requests.push(request);port.postMessage([schema,this.binding,"reply",request[2],{ok:true,snapshot:FakeWorker.snapshot}]);
    });port.start();
  }
}
const store=new Map<string,string>();
const localStorage={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
let page=new EventTarget();
const actions=()=>FakeWorker.all.flatMap(w=>w.requests.map(r=>r[3]));

/** A new document of the app (a reload): its own window, same storage. */
const reload=()=>{
  const next=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
  page=next;vi.stubGlobal("window",next);vi.stubGlobal("location",next.location);
  return new MdbaseConnect(declaration).application();
};
beforeEach(()=>{
  FakeWorker.all=[];FakeWorker.snapshot=paired;store.clear();
  vi.stubGlobal("Worker",FakeWorker);vi.stubGlobal("localStorage",localStorage);
  // A browser page also has locks, storage and IndexedDB (entry capability probe).
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
});
afterEach(()=>{vi.unstubAllGlobals();});

describe("collection list",()=>{
  it("refreshes once when the app is focused again, only when signed in and settled",async()=>{
    const app=reload();await app.start();
    page.dispatchEvent(new Event("focus"));page.dispatchEvent(new Event("focus"));
    await vi.waitFor(()=>expect(actions()).toEqual(["start","refreshCollections"]));
    FakeWorker.all=[];FakeWorker.snapshot={...paired,status:"signed_out",signIn:null,collections:[]};
    const out=reload();await out.start();
    page.dispatchEvent(new Event("focus"));await new Promise(r=>setTimeout(r,20));
    expect(actions()).toEqual(["start"]);
  });
  it("a forgotten collection stays hidden after a reload, for that account only",async()=>{
    const app=reload();await app.start();
    expect((await app.forget(B)).collections.map(c=>c.collectionId)).toEqual([A]);
    expect(actions()).not.toContain("forget"); // the session keeps it, so a later approval can show it again
    const reloaded=reload();
    expect((await reloaded.start()).collections.map(c=>c.collectionId)).toEqual([A]);
    FakeWorker.snapshot={...paired,signIn:{...signIn,accountId:"acct-2"}};
    const other=reload();
    expect((await other.start()).collections.map(c=>c.collectionId)).toEqual([A,B]);
  });
  it("switching collections pushes a history entry, so Back returns to the previous one",async()=>{
    const app=reload();await app.start();
    const history=(page as unknown as {history:{pushState:()=>void;replaceState:()=>void}}).history;
    const push=vi.spyOn(history,"pushState"),replace=vi.spyOn(history,"replaceState");
    void app.select(A).catch(()=>{});
    await vi.waitFor(()=>expect(push).toHaveBeenCalledOnce());
    expect(String((push.mock.calls[0] as unknown[])[2])).toContain(`collection=${A}`);expect(replace).not.toHaveBeenCalled();
  });
});
