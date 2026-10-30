import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";

// Same boundary as application-page-lifecycle: real entry, selection, runtime,
// Worker client and popup adapter; scripted Worker and build/network inputs.
vi.mock("../src/application/registration.js",()=>({resolveApplicationRegistration:async()=>({id:"55555555-5555-4555-8555-555555555555",name:"Example"})}));
vi.mock("../src/application/packaged-assets.js",()=>({packagedApplicationAssets:()=>({})}));
vi.mock("../src/application/packaged-trust.js",()=>({appReleaseTrust:()=>null}));
vi.mock("../src/app-host/app-environment.js",()=>({selectAppEnvironment:()=>({cpOrigin:"https://cp.test"})}));
vi.mock("../src/app-host/app-origin.js",async original=>{
  const actual=await original<typeof import("../src/app-host/app-origin.js")>();
  return {...actual,urlOrigin:(url:URL)=>url.protocol==="file:"?"https://app.test":actual.urlOrigin(url)};
});
const {MdbaseConnect}=await import("../src/application/entry.js");
const origin="https://app.test",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const declaration={id:"org.example.app",name:"Example",origin,environment:"lab" as const,manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
  redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}};
const signedOut={status:"signed_out",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};
const authorizing={...signedOut,status:"authorizing"};

class FakeWorker {
  static all:FakeWorker[]=[];static hold=false;
  readonly terminate=vi.fn();readonly requests:unknown[][]=[];
  port!:MessagePort;binding="";waiting=false;held:number|null=null;
  constructor(){FakeWorker.all.push(this);}
  addEventListener(){}removeEventListener(){}
  postMessage(message:unknown[],transfer:MessagePort[]){
    this.binding=message[1] as string;this.port=transfer[0]!;
    this.port.addEventListener("message",event=>{
      const r=event.data as unknown[];if(r[3]==="foreground")return;
      this.requests.push(r);
      if(r[3]==="authorize"){
        // AppScopedSignInSession refuses a second authorization while its
        // original approvalOwner is authorizing, even after the handoff reply.
        if(this.waiting){this.port.postMessage([schema,this.binding,"reply",r[2],{ok:false,problem:{code:"busy"}}]);return;}
        this.waiting=true;
        this.port.postMessage([schema,this.binding,"portal",r[2],{action:"navigate",uri:"https://cp.test/pair/original"}]);
        if(FakeWorker.hold){this.held=r[2] as number;return;}
        this.reply(r[2] as number,authorizing);return;
      }
      if(r[3]==="approvalClosed")return; // receipt outcome is delivered explicitly
      this.reply(r[2] as number,r[3]==="close"?{...signedOut,status:"closed"}:signedOut);
    });this.port.start();
  }
  reply(id:number,snapshot:unknown){this.port.postMessage([schema,this.binding,"reply",id,{ok:true,snapshot}]);}
  closedReceipt(){this.waiting=false;this.port.postMessage([schema,this.binding,"nativeSnapshot",0,{...signedOut,problem:"approval_window_closed",approval:{outcome:"closed"}}]);}
}
function popup(){return {closed:false,location:{href:"about:blank"},focus:vi.fn(),close:vi.fn(function(this:{closed:boolean}){this.closed=true;})};}
const popups:Array<ReturnType<typeof popup>>=[];
const open=vi.fn(()=>{const p=popup();popups.push(p);return p;});
let page:EventTarget;
const authorizations=()=>FakeWorker.all.flatMap(w=>w.requests.filter(r=>r[3]==="authorize"));
beforeEach(()=>{
  FakeWorker.all=[];FakeWorker.hold=false;popups.length=0;open.mockClear();
  const browser=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}},open,focus:vi.fn()});page=browser;
  vi.stubGlobal("window",browser);vi.stubGlobal("location",browser.location);vi.stubGlobal("Worker",FakeWorker);
  vi.stubGlobal("indexedDB",new IDBFactory());
  vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
});
afterEach(()=>{page.dispatchEvent(Object.assign(new Event("pagehide"),{persisted:false}));for(const w of FakeWorker.all)w.port.close();vi.unstubAllGlobals();});

describe("approval window from the original gesture",()=>{
  it("open again focuses the handed-off window, without replacing the portal or sending a busy second approval",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();await app.authorize();
    expect(popups[0]!.location.href).toBe("https://cp.test/pair/original");
    await expect(app.authorize()).resolves.toMatchObject({status:"authorizing",problem:null});
    expect(open).toHaveBeenCalledOnce();expect(popups[0]!.focus).toHaveBeenCalledOnce();expect(popups[0]!.closed).toBe(false);
    expect(authorizations()).toHaveLength(1);
    await expect(app.approve(A)).rejects.toMatchObject({code:"application_selection_busy"});
    expect(open).toHaveBeenCalledOnce();expect(popups[0]!.closed).toBe(false);expect(authorizations()).toHaveLength(1);
  });
  it("focus during handoff leaves the original request pending and its single-flight guard intact",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();FakeWorker.hold=true;
    let finished=false;const original=app.authorize().then(s=>{finished=true;return s;});void original.catch(()=>{});
    await vi.waitFor(()=>expect(FakeWorker.all[0]!.held).not.toBeNull());
    await expect(app.authorize()).resolves.toBeDefined();
    expect(finished).toBe(false);expect(open).toHaveBeenCalledOnce();expect(popups[0]!.focus).toHaveBeenCalledOnce();
    await expect(app.approve(A)).rejects.toMatchObject({code:"application_selection_busy"});
    const w=FakeWorker.all[0]!;w.reply(w.held!,authorizing);await original;expect(authorizations()).toHaveLength(1);
  });
  it("reauthorize and approve share the original collection-bound window",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();await app.approve(A);
    await expect(app.reauthorize()).resolves.toMatchObject({status:"authorizing"});await expect(app.approve(A)).resolves.toMatchObject({status:"authorizing"});
    expect(popups[0]!.focus).toHaveBeenCalledTimes(2);expect(open).toHaveBeenCalledOnce();expect(authorizations().map(r=>r[4])).toEqual([A]);
  });
  it("an aborted repeat gesture cannot focus or cancel the original approval",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();const owner=new AbortController();await app.authorize({signal:owner.signal});
    const repeat=new AbortController();repeat.abort();await expect(app.authorize({signal:repeat.signal})).rejects.toMatchObject({code:"cancelled"});
    expect(popups[0]!.focus).not.toHaveBeenCalled();expect(popups[0]!.closed).toBe(false);expect(owner.signal.aborted).toBe(false);expect(authorizations()).toHaveLength(1);
  });
  it("pagehide fences the retained UI handle instead of focusing a retired window",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();await app.authorize();
    page.dispatchEvent(Object.assign(new Event("pagehide"),{persisted:true}));
    await expect(app.authorize()).rejects.toMatchObject({reason:"application_entry_fenced"});
    expect(popups[0]!.focus).not.toHaveBeenCalled();expect(popups[0]!.closed).toBe(true);expect(open).toHaveBeenCalledOnce();
  });
  it("a closed window waits for the original receipt outcome; only then can a new gesture restart",async()=>{
    const app=new MdbaseConnect(declaration,{privateCollections:false}).application();await app.start();await app.authorize();popups[0]!.closed=true;
    // Closed is not a receipt, cancellation certificate or replacement permit.
    await expect(app.authorize()).resolves.toMatchObject({status:"authorizing"});expect(open).toHaveBeenCalledOnce();expect(authorizations()).toHaveLength(1);
    FakeWorker.all[0]!.closedReceipt();await vi.waitFor(()=>expect(app.getSnapshot().selection?.approval).toBeNull());
    await app.authorize();expect(open).toHaveBeenCalledTimes(2);expect(authorizations()).toHaveLength(2);expect(popups[1]!.closed).toBe(false);
  });
});
