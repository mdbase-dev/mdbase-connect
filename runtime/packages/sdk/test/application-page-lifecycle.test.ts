import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";

// Registration, packaged assets and environment are network/build concerns
// outside this test; the module URL is file: under vitest, so its origin check
// is bound to the test origin. Everything else is the real entry and runtime.
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {MdbaseConnect}=await import("../src/application/entry.js");

const origin="https://app.test";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const unselected={status:"unselected",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};

/** Scripted application Worker: records requests; replies only when told. */
class FakeWorker {
  static all:FakeWorker[]=[];static replies=true;
  readonly terminate=vi.fn();readonly requests:unknown[][]=[];
  port:MessagePort|null=null;binding="";autoReply=FakeWorker.replies;
  constructor(){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  postMessage(message:unknown[],transfer:MessagePort[]){
    this.binding=message[1] as string;const port=transfer[0]!;this.port=port;
    port.addEventListener("message",event=>{
      const request=event.data as unknown[];if(request[3]==="foreground")return; // one-way
      this.requests.push(request);
      if(this.autoReply)this.reply(request[2] as number);
    });port.start();
  }
  reply(id:number,snapshot:unknown=unselected){this.port!.postMessage([schema,this.binding,"reply",id,{ok:true,snapshot}]);}
}
const newPage=()=>Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
let page=newPage();
const transition=(type:"pagehide"|"pageshow",persisted:boolean)=>page.dispatchEvent(Object.assign(new Event(type),{persisted}));
const actions=(worker:FakeWorker)=>worker.requests.map(request=>request[3]);

beforeEach(()=>{
  FakeWorker.all=[];FakeWorker.replies=true;page=newPage();
  vi.stubGlobal("window",page);vi.stubGlobal("location",page.location);vi.stubGlobal("Worker",FakeWorker);
  // A browser page also has locks, storage and IndexedDB (entry capability probe).
  vi.stubGlobal("indexedDB",new IDBFactory());
  vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
});
afterEach(()=>{vi.unstubAllGlobals();});

describe("application entry across the back/forward cache",()=>{
  it("a persisted pagehide terminates the Worker at once and fences every request",async()=>{
    const app=new MdbaseConnect(declaration).application();
    FakeWorker.replies=false;const starting=app.start();
    await vi.waitFor(()=>expect(FakeWorker.all[0]?.requests).toHaveLength(1));
    const worker=FakeWorker.all[0]!;
    // The start request is still in flight: the page goes into bfcache now.
    transition("pagehide",true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(starting).rejects.toMatchObject({code:"application_worker_fenced"});
    await expect(app.start()).rejects.toMatchObject({reason:"application_entry_fenced"});
    expect(FakeWorker.all).toHaveLength(1);expect(worker.requests).toHaveLength(1);
  });

  it("a persisted pageshow starts a fresh Worker and session, and the app re-renders from it",async()=>{
    const app=new MdbaseConnect(declaration).application();
    await app.start();
    const first=FakeWorker.all[0]!;expect(app.getSnapshot().status).toBe("unselected");
    transition("pagehide",true);expect(first.terminate).toHaveBeenCalledOnce();
    const seen:string[]=[];app.subscribe(()=>seen.push(app.getSnapshot().status));
    transition("pageshow",true);
    await vi.waitFor(()=>expect(app.getSnapshot().status).toBe("unselected"));
    expect(FakeWorker.all).toHaveLength(2);
    const second=FakeWorker.all[1]!;
    expect(second.binding).not.toBe(first.binding);expect(actions(second)).toEqual(["start"]);expect(actions(first)).toEqual(["start"]);
    expect(seen).toContain("starting");expect(second.terminate).not.toHaveBeenCalled();
    expect(app.getSnapshot().problem).toBeNull();
  });

  it("a non-persisted pagehide (unload) terminates too and nothing restarts",async()=>{
    const connect=new MdbaseConnect(declaration),app=connect.application();
    await app.start();
    transition("pagehide",false);
    expect(FakeWorker.all[0]!.terminate).toHaveBeenCalledOnce();
    transition("pageshow",false);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(FakeWorker.all).toHaveLength(1);
    await expect(app.start()).rejects.toMatchObject({reason:"application_entry_fenced"});
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("a closed application no longer follows page transitions",async()=>{
    const app=new MdbaseConnect(declaration).application();
    const starting=app.start();
    await vi.waitFor(()=>expect(FakeWorker.all[0]?.requests).toHaveLength(1));
    await starting;
    const worker=FakeWorker.all[0]!;
    // Terminal close ACK from the Worker, then the page leaves.
    worker.autoReply=false;const closed=app.close();
    await vi.waitFor(()=>expect(actions(worker)).toContain("close"));
    worker.reply(worker.requests.at(-1)![2] as number,{...unselected,status:"closed"});await closed;
    expect(worker.terminate).toHaveBeenCalledOnce();
    transition("pagehide",true);transition("pageshow",true);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(FakeWorker.all).toHaveLength(1);expect(app.getSnapshot().status).toBe("closed");
  });
});

describe("application entry when the app is open in another tab",()=>{
  const blocked={...unselected,status:"blocked",problem:"open_in_another_tab"};
  function otherTab(){
    const waits:{name:string;mode:string;release:()=>void}[]=[];
    const locks={request:vi.fn((name:string,options:{mode:string;signal:AbortSignal},granted:(lock?:unknown)=>Promise<void>)=>name.startsWith("mdbn-app-tabs/")
      // This tab leads its own tab group; the other tab runs a different build.
      ?Promise.resolve(granted({name})):new Promise<void>((resolve,reject)=>{
      options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true});
      waits.push({name,mode:options.mode,release:()=>{void granted().then(resolve);}});
    }))};
    vi.stubGlobal("navigator",{locks,storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});return waits;
  }
  const doc=(state:"visible"|"hidden")=>{const d=Object.assign(new EventTarget(),{visibilityState:state});vi.stubGlobal("document",d);return d;};

  it("waits for the other tab's release, then starts again by itself",async()=>{
    const waits=otherTab();doc("visible");
    const app=new MdbaseConnect(declaration).application();
    FakeWorker.replies=false;const starting=app.start();
    await vi.waitFor(()=>expect(FakeWorker.all[0]?.requests).toHaveLength(1));
    const worker=FakeWorker.all[0]!;worker.reply(worker.requests[0]![2] as number,blocked);await starting;
    expect(app.getSnapshot()).toMatchObject({status:"blocked",problem:"open_in_another_tab"});
    await vi.waitFor(()=>expect(waits).toHaveLength(1));
    expect(waits[0]).toMatchObject({name:"mdbase-app-sign-in-v1-55555555-5555-4555-8555-555555555555-https://cp.test",mode:"shared"});
    await new Promise(resolve=>setTimeout(resolve,10));expect(actions(worker)).toEqual(["start"]);
    worker.autoReply=true;waits[0]!.release();
    await vi.waitFor(()=>expect(app.getSnapshot().status).toBe("unselected"));
    expect(actions(worker)).toEqual(["start","start"]);expect(waits).toHaveLength(1);
  });

  it("start resolves while the app is open in another tab (the Worker refuses with that code)",async()=>{
    otherTab();doc("visible");
    const app=new MdbaseConnect(declaration).application();
    FakeWorker.replies=false;const starting=app.start();
    await vi.waitFor(()=>expect(FakeWorker.all[0]?.requests).toHaveLength(1));
    const worker=FakeWorker.all[0]!,id=worker.requests[0]![2] as number;
    worker.port!.postMessage([schema,worker.binding,"nativeSnapshot",0,blocked]);
    worker.port!.postMessage([schema,worker.binding,"reply",id,{ok:false,problem:{code:"open_in_another_tab"}}]);
    expect(await starting).toMatchObject({status:"blocked",problem:"open_in_another_tab"});
  });

  it("createMdbase with followVisibility constructs in a browser and starts in the page's state",async()=>{
    const {createMdbase}=await import("../src/application/front-door.js");
    const d=doc("hidden");
    const mdbase=createMdbase(declaration,{followVisibility:true});
    expect((mdbase as unknown as {entry?:unknown}).entry??mdbase).toBeTruthy();
    d.visibilityState="visible";d.dispatchEvent(new Event("visibilitychange"));
    await mdbase.close();
  });

  it("a hidden tab takes over only once it is shown",async()=>{
    const waits=otherTab(),d=doc("hidden");
    const app=new MdbaseConnect(declaration).application();
    FakeWorker.replies=false;const starting=app.start();
    await vi.waitFor(()=>expect(FakeWorker.all[0]?.requests).toHaveLength(1));
    const worker=FakeWorker.all[0]!;worker.reply(worker.requests[0]![2] as number,blocked);await starting;
    await vi.waitFor(()=>expect(waits).toHaveLength(1));
    worker.autoReply=true;waits[0]!.release();
    await new Promise(resolve=>setTimeout(resolve,10));expect(actions(worker)).toEqual(["start"]);
    d.visibilityState="visible";d.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(()=>expect(actions(worker)).toEqual(["start","start"]));
  });
});

describe("application entry in a browser below the feature floor",()=>{
  it("never starts the Worker and reports browser_unsupported on the unavailable phase",async()=>{
    // No Web Locks (an old browser): the upfront probe stops initialization.
    vi.stubGlobal("navigator",{storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
    const app=new MdbaseConnect(declaration).application();
    await expect(app.start()).rejects.toMatchObject({code:"unavailable",reason:"browser_unsupported"});
    expect(FakeWorker.all).toHaveLength(0);
    expect(app.getSnapshot()).toMatchObject({status:"blocked",problem:"browser_unsupported",phase:{kind:"unavailable",problem:{key:"browser_unsupported"}}});
  });
});
