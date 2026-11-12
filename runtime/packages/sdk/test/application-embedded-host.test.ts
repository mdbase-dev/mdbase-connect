import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";

// A page embedded in another app (a `blob:` document): the `worker` and
// `urlSelection` options. Registration, packaged assets and environment are
// network/build concerns outside this test (as in the page-lifecycle test); the
// module URL is file: under vitest, so its origin check is bound to the test
// origin. Everything else is the real entry and runtime.
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {createMdbase}=await import("../src/application/front-door.js");

const origin="https://app.test",id="11111111-1111-4111-8111-111111111111";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const unselected={status:"unselected",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};
// The SDK Worker script beside the entry module, as the entry names it.
const workerUrl=new URL("../src/application/worker.js",import.meta.url).href;

/** Scripted application Worker: records construction and bootstrap; replies to every request. */
class FakeWorker {
  static all:FakeWorker[]=[];
  readonly terminate=vi.fn();readonly requests:unknown[][]=[];bootstrap:unknown[]=[];
  port:MessagePort|null=null;binding="";
  constructor(readonly url?:unknown,readonly options?:unknown){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  postMessage(message:unknown[],transfer:MessagePort[]){
    this.bootstrap=message;this.binding=message[1] as string;const port=transfer[0]!;this.port=port;
    port.addEventListener("message",event=>{
      const request=event.data as unknown[];if(request[3]==="foreground")return;
      this.requests.push(request);port.postMessage([schema,this.binding,"reply",request[2],{ok:true,snapshot:unselected}]);
    });port.start();
  }
}
const history=()=>({state:null,pushState:vi.fn(),replaceState:vi.fn()});
const newPage=(href:string)=>Object.assign(new EventTarget(),{location:{origin,href},history:history()});
let page=newPage(`${origin}/`);
function open(href:string){
  page=newPage(href);vi.stubGlobal("window",page);vi.stubGlobal("location",page.location);
}

beforeEach(()=>{
  FakeWorker.all=[];open(`${origin}/`);vi.stubGlobal("Worker",FakeWorker);
  vi.stubGlobal("indexedDB",new IDBFactory());
  vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
});
afterEach(()=>{vi.unstubAllGlobals();});

describe("worker option",()=>{
  it("by default the SDK constructs its own module Worker and does not name its URL to it",async()=>{
    const app=createMdbase(declaration);await app.start();
    expect(FakeWorker.all).toHaveLength(1);
    const worker=FakeWorker.all[0]!;
    expect(String(worker.url)).toBe(workerUrl);expect(worker.options).toEqual({type:"module"});
    expect(worker.bootstrap).toHaveLength(3);
  });

  it("calls the host's factory with the SDK Worker URL, and names that URL to the Worker for its assets",async()=>{
    // The SDK's own construction is not used.
    vi.stubGlobal("Worker",class {constructor(){throw new Error("SDK-constructed Worker");}});
    const factory=vi.fn((url:string)=>new FakeWorker(url) as unknown as Worker);
    const app=createMdbase(declaration,{worker:factory});
    await app.start();
    expect(factory).toHaveBeenCalledOnce();expect(factory).toHaveBeenCalledWith(workerUrl);
    const worker=FakeWorker.all[0]!,[protocol,binding,sent,namespace,anchor]=worker.bootstrap;
    expect(protocol).toBe(schema);expect(binding).toBe(worker.binding);
    expect(sent).toMatchObject({origin});expect(namespace).toBeNull();expect(anchor).toBe(workerUrl);
    expect(app.getSnapshot().status).toBe("unselected");
  });

  it("passes the declared storage namespace beside the URL",async()=>{
    const factory=(url:string)=>new FakeWorker(url) as unknown as Worker;
    await createMdbase({...declaration,storage:{applicationNamespace:"vault-a"}},{worker:factory}).start();
    expect(FakeWorker.all[0]!.bootstrap.slice(3)).toEqual(["vault-a",workerUrl]);
  });

  it("describes a problem in the app's own words, and keeps the English copy for what it leaves out",async()=>{
    const messages={application_worker_unavailable:{title:"Impossible de démarrer"}};
    const app=createMdbase(declaration,{messages,worker:()=>{throw new Error("no blob Worker here");}});
    await expect(app.start()).rejects.toMatchObject({reason:"application_worker_unavailable"});
    const phase=app.getSnapshot().phase!;
    expect(phase).toMatchObject({kind:"unavailable",problem:{key:"application_worker_unavailable",title:"Impossible de démarrer"}});
    const english=createMdbase(declaration,{worker:()=>{throw new Error("no blob Worker here");}});
    await expect(english.start()).rejects.toThrow();
    const plain=english.getSnapshot().phase!;
    if(phase.kind!=="unavailable"||plain.kind!=="unavailable")throw Error("expected the unavailable phase");
    expect(plain.problem.title).not.toBe(phase.problem.title);expect(phase.problem.message).toBe(plain.problem.message);
  });

  it.each([
    ["throws",()=>{throw new Error("no blob Worker here");}],
    ["returns no Worker",()=>({postMessage(){}})],
    ["returns nothing",()=>undefined],
  ])("a factory that %s fails start with application_worker_unavailable",async(_name,factory)=>{
    const app=createMdbase(declaration,{worker:factory as unknown as (url:string)=>Worker});
    await expect(app.start()).rejects.toMatchObject({code:"unavailable",reason:"application_worker_unavailable"});
    expect(app.getSnapshot()).toMatchObject({status:"blocked",problem:"application_worker_unavailable"});
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("refuses a factory that is not a function at construction",()=>{
    for(const worker of [null,"./worker.js",new URL(workerUrl),{}])
      expect(()=>createMdbase(declaration,{worker:worker as unknown as (url:string)=>Worker})).toThrow(new TypeError("worker must be a function"));
  });
});

describe("urlSelection option",()=>{
  it("by default reads the requested collection from the page URL and writes the selection back",async()=>{
    open(`${origin}/?collection=${id}`);
    const app=createMdbase(declaration);await app.start();
    expect(app.getSnapshot().selection.requested).toMatchObject({collectionId:id,source:"url"});
    await app.chooseAnother();
    expect(page.history.pushState).toHaveBeenCalledWith(null,"",`${origin}/`);
  });

  it("by default a blob: document cannot bind its selection",async()=>{
    open(`blob:${origin}/7b0c6a1e-2b52-4a8e-9f3c-2c6e1f0d9a11`);
    const app=createMdbase(declaration);await app.start();
    expect(app.getSnapshot().selection).toMatchObject({problem:"application_selection_binding"});
  });

  it("false never reads or writes the URL: a blob: document selects through the API",async()=>{
    open(`blob:${origin}/7b0c6a1e-2b52-4a8e-9f3c-2c6e1f0d9a11`);
    const app=createMdbase(declaration,{urlSelection:false});await app.start();
    expect(app.getSnapshot().selection).toMatchObject({problem:null,requested:{collectionId:null,source:"none"}});
    await app.select(id);
    expect(app.getSnapshot().selection.requested).toMatchObject({collectionId:id,source:"user"});
    await app.chooseAnother();
    expect(app.getSnapshot().selection.requested).toMatchObject({collectionId:null,source:"none"});
    expect(page.history.pushState).not.toHaveBeenCalled();expect(page.history.replaceState).not.toHaveBeenCalled();
  });

  it("false ignores a collection named in the page URL",async()=>{
    open(`${origin}/?collection=${id}`);
    const app=createMdbase(declaration,{urlSelection:false});await app.start();
    expect(app.getSnapshot().selection.requested).toMatchObject({collectionId:null,source:"none"});
  });

  it("refuses a value that is not a boolean at construction",()=>{
    for(const urlSelection of [null,0,"false",{}])
      expect(()=>createMdbase(declaration,{urlSelection:urlSelection as unknown as boolean})).toThrow(new TypeError("urlSelection must be a boolean"));
  });
});
