import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {IDBFactory} from "fake-indexeddb";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";
import {pipeCloseError} from "../src/transport/relay-pipe.js";

// SDK-10: Private collections list beside hosted ones and open from the same
// selection, against the real entry and runtime with a scripted Worker.
const P="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const opened:{close:ReturnType<typeof vi.fn>}[]=[];
/** Holds the grant list read (from local storage) until released. */
const gate:{wait:Promise<void>|null;error:unknown}={wait:null,error:null};
vi.mock("../src/app-grant/client.js",()=>({MdbaseAppGrants:class{
  verifiedStoredNativeGrant=async()=>true;
  collections=async(options?:{bindings?:readonly {collection_id:string}[]})=>{await gate.wait;if(options?.bindings && !options.bindings.some(c=>c.collection_id===P))return [];return [{collectionId:P,displayName:"Private notes",operations:[],role:"owner",availability:{state:"available"}}];};
  availability=async()=>({state:"available"});waitForAvailable=async()=>({state:"available"});
  connector=()=>({});people=()=>({});forget=async()=>{};authorize=async()=>({collectionId:P});
  setup=()=>({assess:async()=>"ready",plan:async()=>({}),apply:async()=>"ready"});
}}));
vi.mock("../src/client.js",()=>({connect:async()=>{if(gate.error)throw gate.error;const c={collection:P,files:{},close:vi.fn(),ledger:{subscribe:()=>()=>{},getSnapshot:()=>null},status:{},onStatus:()=>()=>{},onLink:()=>()=>{}};opened.push(c);return c;}}));
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
const nativeGrant={account_id:"acct-1",collection_id:P,authorization_request_id:"n1",client_noise_public_key:"test-only-original-noise"};
const signIn={nativeGrants:[nativeGrant],requestId:"r1",installationId:"i1",deviceId:"d1",appId:"p1",kind:"app-runtime",verificationUri:"https://cp.test/pair",state:"paired",accountId:"acct-1",
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
const reload=(options={},href=`${origin}/`)=>{
  const next=Object.assign(new EventTarget(),{location:{origin,href},history:{state:null,pushState(){},replaceState(){}}});
  page=next;vi.stubGlobal("window",next);vi.stubGlobal("location",next.location);
  return new MdbaseConnect(declaration,options).application();
};
beforeEach(()=>{
  opened.length=0;gate.wait=null;gate.error=null;
  FakeWorker.all=[];FakeWorker.snapshot=paired;store.clear();
  vi.stubGlobal("Worker",FakeWorker);vi.stubGlobal("localStorage",localStorage);
  // A browser page also has locks, storage and IndexedDB (entry capability probe).
  vi.stubGlobal("indexedDB",new IDBFactory());vi.stubGlobal("navigator",{locks:{request:async(_n:unknown,_o:unknown,cb:(l:unknown)=>unknown)=>cb({})},storage:{getDirectory:async()=>({}),persisted:async()=>false,persist:async()=>false}});
});
afterEach(()=>{vi.unstubAllGlobals();});

describe("Private collections",()=>{
  it("lists a Private collection with the hosted ones, opens it in this page, and leaves it for a hosted one",async()=>{
    const app=reload();await app.start();
    await vi.waitFor(()=>expect(app.getSnapshot().collections.map(c=>[c.collectionId,c.kind??"cloud_copy"])).toEqual([[A,"cloud_copy"],[B,"cloud_copy"],[P,"private"]]));
    await app.select(P);
    await vi.waitFor(()=>expect(app.getSnapshot()).toMatchObject({status:"ready",selectedCollectionId:P,phase:{kind:"ready"}}));
    expect(app.getSnapshot().selection.usable?.collectionId).toBe(P);
    expect(actions()).not.toContain("select"); // never through the Worker
    await app.select(A);
    expect(opened[0]!.close).toHaveBeenCalled();
    expect(actions()).toContain("select");
  });
  it("carries bounded close diagnostics through the real entry snapshot and problem phase",async()=>{
    const app=reload();await app.start();
    await vi.waitFor(()=>expect(app.getSnapshot().collections.some(c=>c.collectionId===P)).toBe(true));
    gate.error=pipeCloseError(1006,"PRIVATE_CLOSE_TEXT");
    await app.select(P);
    await vi.waitFor(()=>expect(app.getSnapshot().status).toBe("blocked"));
    const snapshot=app.getSnapshot();
    expect(snapshot).toMatchObject({status:"blocked",selectedCollectionId:P,problem:"relay_closed",
      problemDetail:{name:"MdbaseError",code:"unavailable",relay:{closeCode:1006,closeClass:"abnormal"}},
      phase:{kind:"problem",problem:{code:"relay_closed"}}});
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_CLOSE_TEXT");
    expect(actions()).not.toContain("select");
    expect(opened).toHaveLength(0);
    gate.error=null;
    await app.select(P);
    await vi.waitFor(()=>expect(app.getSnapshot()).toMatchObject({status:"ready",problem:null,phase:{kind:"ready"}}));
    expect(app.getSnapshot()).not.toHaveProperty("problemDetail");
    FakeWorker.snapshot={...paired,status:"closed"};await app.close();
  });
  it("a successful Private add clears a previously cancelled hosted add",async()=>{
    const app=reload();
    Object.assign(window,{open:()=>({location:{href:"about:blank"},closed:false,close(){}})});
    await app.start();
    await vi.waitFor(()=>expect(app.getSnapshot().collections.some(c=>c.collectionId===P)).toBe(true));
    FakeWorker.snapshot={...paired,approval:{outcome:"closed"}};
    await app.approve(null);
    await vi.waitFor(()=>expect(app.getSnapshot().selection.lastApproval).toEqual({kind:"add",outcome:"closed",collectionId:null}));
    FakeWorker.snapshot={...paired,signIn:{...signIn,nativeSelection:{requestId:"r1",authorizationRequestId:"n1",collectionId:P}}};
    await app.addPrivateCollection!();
    expect(actions().filter(a=>a==="authorize")).toHaveLength(2); // same ordinary Sign in/Add route, never separate Native authorize
    await vi.waitFor(()=>expect(app.getSnapshot()).toMatchObject({status:"ready",selectedCollectionId:P}));
    expect(app.getSnapshot().selection.lastApproval).toEqual({kind:"add",outcome:"unchanged",collectionId:P});
    await app.chooseAnother();
    expect(app.getSnapshot().phase).toMatchObject({kind:"choosing",lastApproval:{kind:"add",outcome:"unchanged",collectionId:P}});
    FakeWorker.snapshot={...paired,status:"closed"};
    await app.close();
  });
  it("opening a Private collection from the URL shows opening while the grant list loads, never approval required",async()=>{
    let release=()=>{};gate.wait=new Promise<void>(resolve=>{release=resolve;});
    const app=reload({},`${origin}/?collection=${P}`);
    const phases:string[]=[],states:string[]=[];
    app.subscribe(()=>{const s=app.getSnapshot();phases.push(s.phase?.kind??"none");states.push(s.selection.state);});
    await app.start();
    await vi.waitFor(()=>expect(app.getSnapshot().collections.map(c=>c.collectionId)).toEqual([A,B]));
    await new Promise(r=>setTimeout(r,20));
    expect(app.getSnapshot()).toMatchObject({selection:{state:"pending",requested:{collectionId:P}},phase:{kind:"opening",collectionId:P}});
    release();
    await vi.waitFor(()=>expect(app.getSnapshot()).toMatchObject({status:"ready",selectedCollectionId:P,phase:{kind:"ready"}}));
    expect(states).not.toContain("approval_required");
    expect(phases.filter(kind=>kind==="needs_approval"||kind==="problem"||kind==="choosing")).toEqual([]);
  });
  it("a requested collection in neither list reads as approval required once the grant list is read",async()=>{
    const C="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const app=reload({},`${origin}/?collection=${C}`);await app.start();
    await vi.waitFor(()=>expect(app.getSnapshot()).toMatchObject({selection:{state:"approval_required"},phase:{kind:"needs_approval",collectionId:C}}));
  });
  it("an app that lists them itself opts out",async()=>{
    const app=reload({privateCollections:false});await app.start();
    await new Promise(r=>setTimeout(r,20));
    expect(app.getSnapshot().collections.map(c=>c.collectionId)).toEqual([A,B]);
  });
});
