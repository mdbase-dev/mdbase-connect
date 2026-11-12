import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";
import {webLocks} from "./support/web-locks.js";

// The `session` option: contexts of one app that are built separately (an
// extension's offscreen document, pages and service worker) use one Worker.
// The real entry, runtime and tab group, with a scripted application Worker;
// registration, assets and environment are stubbed as in the embedded-host test.
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {createMdbase}=await import("../src/application/front-door.js");

const origin="https://app.test";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const unselected={status:"unselected",signIn:null,collections:[],selectedCollectionId:null,problem:null,timing:null};
const signedOut={status:"signed_out",signIn:null,collections:[],selectedCollectionId:null,problem:null,timing:null};

/** Scripted application Worker: its creating page's port plus every attached context's. */
class FakeWorker {
  static all:FakeWorker[]=[];
  readonly terminate=vi.fn();readonly attached:string[]=[];readonly detached:string[]=[];readonly requests:unknown[][]=[];
  private binding="";
  constructor(){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  private serve(port:MessagePort,binding:string){
    port.addEventListener("message",event=>{
      const request=event.data as unknown[],action=request[3];if(action==="foreground")return;
      this.requests.push(request);
      const snapshot=action==="close"?{...signedOut,status:"closed"}:action==="signOut"?{...signedOut,signOutResult:{server:"revoked",local:"erased",webPush:false}}:unselected;
      port.postMessage([schema,binding,"reply",request[2],{ok:true,snapshot}]);
    });port.start();
  }
  postMessage(message:unknown[],transfer:MessagePort[]=[]){
    if(!this.binding){this.binding=message[1] as string;this.serve(transfer[0]!,this.binding);return;}
    if(message[2]==="attach"){this.attached.push(message[3] as string);this.serve(transfer[0]!,message[3] as string);}
    else if(message[2]==="detach")this.detached.push(message[3] as string);
  }
}
const browser=()=>({locks:webLocks(),storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
function page(){
  const next=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
  vi.stubGlobal("window",next);vi.stubGlobal("location",next.location);
}
const build="1.4.2";
const opened:{close():Promise<void>}[]=[];
function context(session:{build:string;host?:boolean}|undefined,options:Record<string,unknown>={}){
  const app=createMdbase(declaration,{...(session?{session}:{}),...options});opened.push(app);return app;
}
const settled=()=>new Promise(resolve=>setTimeout(resolve,30));

beforeEach(()=>{
  FakeWorker.all=[];page();vi.stubGlobal("Worker",FakeWorker);vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("navigator",browser());
});
afterEach(async()=>{for(const app of opened.splice(0))await app.close().catch(()=>{});vi.unstubAllGlobals();});

describe("session option",()=>{
  it("a context that leaves the Worker to another joins the one the host runs, and is detached when it closes",async()=>{
    const host=context({build}),joiner=context({build,host:false});
    await host.start();await joiner.start();
    expect(FakeWorker.all).toHaveLength(1);
    const worker=FakeWorker.all[0]!;
    expect(worker.attached).toHaveLength(1);
    expect(joiner.getSnapshot().status).toBe("unselected");
    // Its requests reach the same Worker on its own port.
    await joiner.refreshCollectionList!();
    expect(worker.requests.filter(request=>request[1]===worker.attached[0]).map(request=>request[3])).toEqual(["start","refreshCollections"]);
    await joiner.close();
    await vi.waitFor(()=>expect(worker.detached).toEqual(worker.attached));
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(host.getSnapshot().status).toBe("unselected");
  });

  it("works where there is no Worker, window or document: a service worker",async()=>{
    const host=context({build});await host.start();
    vi.stubGlobal("Worker",undefined);vi.stubGlobal("window",undefined);vi.stubGlobal("document",undefined);vi.stubGlobal("localStorage",undefined);
    const open=vi.fn();
    const worker=context({build,host:false},{signIn:{open}});
    await worker.start();
    expect(worker.getSnapshot().status).toBe("unselected");
    expect(FakeWorker.all).toHaveLength(1);expect(FakeWorker.all[0]!.attached).toHaveLength(1);
    // The same place cannot host: it reports the SDK as unavailable and allocates nothing.
    const cannot=createMdbase(declaration,{session:{build}});
    expect(cannot.getSnapshot()).toMatchObject({status:"blocked",problem:"application_not_yet_available"});
  });

  it("waits, starting, while no context runs the Worker, and joins once one does",async()=>{
    const joiner=context({build,host:false});
    let done=false;const starting=joiner.start().then(()=>{done=true;});
    await settled();
    expect(done).toBe(false);expect(joiner.getSnapshot().status).toBe("starting");expect(FakeWorker.all).toHaveLength(0);
    const host=context({build});await host.start();
    await starting;
    expect(joiner.getSnapshot().status).toBe("unselected");expect(FakeWorker.all).toHaveLength(1);
  });

  it("after a sign-out stopped the host's Worker, a joining context's next start brings the host back",async()=>{
    const host=context({build}),joiner=context({build,host:false});
    await host.start();await joiner.start();
    await host.signOut!();
    await vi.waitFor(()=>expect(joiner.getSnapshot().status).toBe("signed_out"));
    expect(FakeWorker.all[0]!.terminate).toHaveBeenCalledOnce();
    // Nothing runs now. The joiner cannot run a Worker; the idle host starts one for it.
    await joiner.start();
    expect(FakeWorker.all).toHaveLength(2);expect(FakeWorker.all[1]!.attached).toHaveLength(1);
    expect(joiner.getSnapshot().status).toBe("unselected");
    await vi.waitFor(()=>expect(host.getSnapshot().status).toBe("unselected"));
  });

  it("contexts under different build names never share a Worker",async()=>{
    const host=context({build});await host.start();
    const other=context({build:"1.4.3",host:false});
    void other.start().catch(()=>{});
    await settled();
    expect(other.getSnapshot().status).toBe("starting");expect(FakeWorker.all[0]!.attached).toEqual([]);
    // A second hosting context of that other build runs its own.
    const second=context({build:"1.4.3"});await second.start();
    await vi.waitFor(()=>expect(other.getSnapshot().status).toBe("unselected"));
    expect(FakeWorker.all).toHaveLength(2);expect(FakeWorker.all[1]!.attached).toHaveLength(1);
  });

  it("refuses a malformed option at construction",()=>{
    for(const session of [null,"1.4.2",{},{build:""},{build:7},{build:"a\nb"},{build:"x".repeat(129)}])
      expect(()=>createMdbase(declaration,{session:session as unknown as {build:string}})).toThrow(new TypeError("session.build must be a short non-empty string"));
    expect(()=>createMdbase(declaration,{session:{build,host:"no" as unknown as boolean}})).toThrow(new TypeError("session.host must be a boolean"));
    expect(()=>createMdbase(declaration,{session:{build,host:false},worker:()=>new FakeWorker() as unknown as Worker})).toThrow(new TypeError("worker has no effect with session.host: false"));
  });
});
