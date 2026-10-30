// Two tabs of one app, one shared session in the leader's Worker: each tab
// selects its own collection from its own URL (?collection=), with its own
// history. The real Worker host, sign-in session, Worker clients, browser
// selection and collection selection; native sign-in/host/leases are fixtures.
import {afterEach,describe,expect,it,vi} from "vitest";
import {applicationDeclaration} from "../src/application/declaration.js";
import type {PackagedApplicationNativeAssets} from "../src/application/native-assets.js";
import {ApplicationWorkerHost} from "../src/application/worker-host.js";
import {ApplicationWorkerClient} from "../src/application/worker-client.js";
import * as WorkerSession from "../src/application/worker-session.js";
import type {ApplicationWorkerSessionHost} from "../src/application/worker-session.js";
import {ApplicationBrowserSelection,type ApplicationSelectionBrowserPort} from "../src/application/browser-selection.js";
import {ApplicationCollectionSelection} from "../src/application/collection-selection.js";
import {AppWebSignInSession,type AppWebSignInSnapshot} from "../src/app-host/web-sign-in-session.js";
import {AppProtectedInstallationSignIn,type AppInstallationSignInView} from "../src/app-host/installation-sign-in.js";
import {AppWebCloudCopyHost} from "../src/app-host/cloud-copy-host.js";
import type {AppWebCollectionHandoff,AppWebNativeCollection} from "../src/app-host/web-collection.js";
import type {AppBundledReleaseTrust} from "../src/app-host/cloud-copy-bootstrap.js";
import * as ownership from "../src/app-host/owner.js";
import * as erasure from "../src/app-host/sign-out-erase.js";

const origin="https://notes.example.test",cpOrigin="https://cp.example.test",appId="5cdfa020-c201-4da8-845a-f2cc9969eade";
const account="11111111-1111-4111-8111-111111111111",installation="22222222-2222-4222-8222-222222222222";
const X="33333333-3333-4333-8333-333333333333",Y="77777777-7777-4777-8777-777777777777";
const release:AppBundledReleaseTrust={schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin:"https://log.example.test",assetSha256:"11".repeat(32),source:{repository:"mdbase-dev/mdbase-connect",commit:"22".repeat(20),version:"test"},trustedRoots:[new Uint8Array(32).fill(3)],policyPins:Uint8Array.of(1)};
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();vi.restoreAllMocks();});

/** The leader's Worker: one paired session with two approved collections. */
function leader(){
  let state:AppInstallationSignInView["state"]="paired";
  const view=():AppInstallationSignInView=>({requestId:"44444444-4444-4444-8444-444444444444",installationId:installation,deviceId:"55555555-5555-4555-8555-555555555555",appId,kind:"app-runtime",
    verificationUri:`${cpOrigin}/pair/44444444-4444-4444-8444-444444444444`,state,accountId:state==="pending"?null:account,accountEmail:state==="pending"?null:"person@example.test",
    collectionSelection:state==="paired"?{requestId:"44444444-4444-4444-8444-444444444444",selectedCollectionId:X,createdCollectionIds:[]}:null,collectionIds:state==="paired"?[X,Y]:[],createCollections:false,requestedCreateCollections:false});
  const flow={view,isCurrent:()=>true,collectionConsentView:()=>null,
    listApprovedCollections:vi.fn(async()=>[{collectionId:X,displayName:"Notes",role:"owner" as const},{collectionId:Y,displayName:"Work",role:"owner" as const}]),
    confirmedSelection:()=>({accountId:account,installationId:installation}),close:vi.fn(async()=>{}),
    signOutInstallation:vi.fn(async()=>{state="pending";return "revoked" as const;}),hasWebPushChannel:()=>false};
  vi.spyOn(AppProtectedInstallationSignIn,"open").mockImplementation(async()=>flow as unknown as AppProtectedInstallationSignIn);
  const hosts:Array<{close:ReturnType<typeof vi.fn>}>=[];
  vi.spyOn(AppWebCloudCopyHost,"openInstallationDevice").mockImplementation(async()=>{
    const host={completeInstallationSignIn:vi.fn(async()=>{}),close:vi.fn(async()=>{})};hosts.push(host);return host as unknown as AppWebCloudCopyHost;
  });
  vi.spyOn(ownership,"acquireAppInstallationLease").mockImplementation(async()=>({release:async()=>{}}));
  const leases=new Map<string,number>();
  vi.spyOn(ownership,"acquireAppReplicaLease").mockImplementation(async(_locks,scope)=>{
    // One lease per collection, like the Web Lock: a second holder would fail.
    expect(leases.get(scope.collection)??0).toBe(0);leases.set(scope.collection,1);
    return {release:async()=>{leases.set(scope.collection,0);}};
  });
  vi.spyOn(erasure,"eraseAppInstallationData").mockImplementation(async()=>({ledger:true,complete:true}));
  /** Every collection the session opened, newest last. */
  const opened:Array<{id:string;generation:string;closed:boolean;attached:number;detached:number;live:Map<MessagePort,string>;strays:number;foreground:boolean[];end(reason:"forbidden"|"revoked"|"gone"):void}>=[];
  let callbacks:ApplicationWorkerSessionHost|undefined;
  const ports=(id:string,generation:string):AppWebCollectionHandoff=>{
    const data=new MessageChannel(),control=new MessageChannel();cleanup.push(()=>{data.port1.close();control.port1.close();});
    return Object.freeze({schema:"mdbn-app-collection/1" as const,scope:Object.freeze({account,installation,collection:id}),generation,displayName:id===X?"Notes":"Work",setupMode:"inspect" as const,dataPort:data.port2,controlPort:control.port2});
  };
  const parent=new AbortController();cleanup.push(()=>parent.abort());
  const session=new AppWebSignInSession<AppWebNativeCollection>({appId,appName:"Notes",origin,cpOrigin,environment:"production",release,signal:parent.signal,locks:undefined,
    loadRuntime:async()=>Uint8Array.of(1),autoSelect:"never",openPortal:()=>{throw new Error("no approval in this test");},
    openCollection:async context=>{
      const id=context.scope.collection,generation=crypto.randomUUID(),listeners=new Set<()=>void>();
      let ended:"forbidden"|"revoked"|"gone"|null=null;
      // live: every set of tab ports onto it ("opener", "attach1", ...), by data port.
      const record={id,generation,closed:false,attached:0,detached:0,live:new Map<MessagePort,string>(),strays:0,foreground:[] as boolean[],end:(reason:"forbidden"|"revoked"|"gone")=>{ended=reason;for(const l of [...listeners])l();}};
      opened.push(record);
      const connection:AppWebNativeCollection=Object.freeze({scope:context.scope,generation,isCurrent:()=>!record.closed,
        setForeground:(value:boolean)=>{record.foreground.push(value);},
        attach:()=>{record.attached++;const value=ports(id,generation);record.live.set(value.dataPort,`attach${record.attached}`);return value;},
        detach:(value:AppWebCollectionHandoff)=>{if(record.live.delete(value.dataPort))record.detached++;else record.strays++;}});
      // The tab that asked gets the original ports.
      const original=ports(id,generation);record.live.set(original.dataPort,"opener");
      callbacks!.handoff(original);
      return {state:"ready",connection,close:async()=>{record.closed=true;},subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},get ended(){return ended;}};
    }});
  vi.spyOn(WorkerSession,"applicationWorkerSession").mockImplementation((_declaration,_packaged,host)=>{callbacks=host;return {session} as unknown as ReturnType<typeof WorkerSession.applicationWorkerSession>;});
  const declaration=applicationDeclaration({id:appId,name:"Notes",origin,environment:"production",manifest:{manifest_version:1,id:"dev.example.notes",name:"Notes",homepage:origin,redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"],optional:[]}}}});
  const packaged={release:()=>release} as unknown as PackagedApplicationNativeAssets;
  const primary=new MessageChannel();
  const host=new ApplicationWorkerHost(primary.port1,"leader_binding_00001",declaration,packaged,undefined,null);
  cleanup.push(()=>host.stop().catch(()=>{}));
  const open=(id:string)=>opened.filter(value=>value.id===id&&!value.closed);
  return {host,session,hosts,opened,open,primary:primary.port2,flow};
}

/** One browser tab: its own URL and history, Worker client and selection. */
function tab(worker:ReturnType<typeof leader>,binding:string,url:string,port?:MessagePort){
  let channel:MessageChannel|null=null;
  if(!port){channel=new MessageChannel();worker.host.attach(channel.port1,binding);port=channel.port2;}
  const history=[url];let index=0;const popstate=new Set<()=>void>();
  const browser:ApplicationSelectionBrowserPort={href:()=>history[index]!,
    write:(href,mode)=>{if(mode==="push"){history.splice(index+1);history.push(href);index++;}else history[index]=href;},
    listen:listener=>{popstate.add(listener);return()=>{popstate.delete(listener);};}};
  let snapshot:AppWebSignInSnapshot|null=null;const listeners=new Set<()=>void>();
  const received:AppWebCollectionHandoff[]=[];
  const set=(value:AppWebSignInSnapshot)=>{snapshot=value;for(const l of [...listeners])l();};
  const client=new ApplicationWorkerClient(port,binding,{snapshot:set,handoff:async value=>{received.push(value);},attached:value=>{received.push(value);},releaseWorker:()=>{}});
  const life=new AbortController();
  let selection:ApplicationCollectionSelection|null=null;
  // The page builds its selection once it has the Worker's first snapshot.
  const ready=async()=>{
    await vi.waitFor(()=>expect(snapshot).not.toBeNull());
    if(snapshot!.status==="not_started")set(await client.request("start",null,life.signal));
    selection=new ApplicationCollectionSelection({browser:new ApplicationBrowserSelection(origin,{},browser),session:{
      getSnapshot:()=>snapshot!,subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
      open:async id=>set(await client.request("select",id,life.signal)),clear:async()=>set(await client.request("clearSelection",null,life.signal)),
      authorize:()=>Promise.reject(new Error("no approval in this test"))}});
    selection.start();
  };
  let gone=false;
  const leave=()=>{if(gone)return;gone=true;selection?.close();life.abort();client.abandon();if(channel)worker.host.detachClient(binding);};
  cleanup.push(leave);
  return {get selection(){return selection!;},client,received,ready,leave,
    snapshot:()=>snapshot!,url:()=>new URL(history[index]!).searchParams.get("collection"),
    back:()=>{index--;for(const l of [...popstate])l();},forward:()=>{index++;for(const l of [...popstate])l();},
    /** This tab shows `id`, open, with ports onto the open connection. */
    shows:(id:string)=>{
      expect(snapshot).toMatchObject({status:"ready",selectedCollectionId:id});
      expect(selection!.getSnapshot()).toMatchObject({state:"usable",usable:{collectionId:id}});
      expect(new URL(history[index]!).searchParams.get("collection")).toBe(id);
      const live=worker.open(id);expect(live).toHaveLength(1);
      expect(received.some(value=>value.generation===live[0]!.generation)).toBe(true);
    }};
}

/** The tab ports still attached to an open collection. */
const holds=(record:{live:Map<MessagePort,string>},labels:string[])=>expect([...record.live.values()].sort()).toEqual([...labels].sort());

describe("per-tab collection selection",()=>{
  it("tab A on X and tab B on Y stay independent through switch, reload, deep link and Back/Forward",async()=>{
    const worker=leader();
    const a=tab(worker,"leader_binding_00001",`${origin}/?collection=${X}`,worker.primary);await a.ready();
    await vi.waitFor(()=>a.shows(X));
    const b=tab(worker,"follower_binding_0001",`${origin}/tasks?collection=${Y}`);await b.ready();
    await vi.waitFor(()=>b.shows(Y));
    // Both open at once, each on its own native host; A did not follow B.
    a.shows(X);expect(worker.session.heldCollections().sort()).toEqual([X,Y].sort());
    expect(new Set(worker.hosts).size).toBe(2);

    // B switches to X (a new history entry): A is untouched; Y, shown by no
    // tab any more, is closed; X stays one open collection for both.
    const firstX=worker.open(X)[0]!;
    await b.selection.select(X,{history:"push"});
    await vi.waitFor(()=>b.shows(X));
    await vi.waitFor(()=>expect(worker.open(Y)).toHaveLength(0));
    a.shows(X);expect(worker.open(X)[0]).toBe(firstX);expect(firstX.attached).toBe(1);

    // Back in B: its URL returns to Y and Y reopens; A still shows X.
    b.back();expect(b.url()).toBe(Y);
    await vi.waitFor(()=>b.shows(Y));a.shows(X);
    expect(firstX.detached).toBe(1);
    // Forward in B: X again, without reopening it.
    b.forward();await vi.waitFor(()=>b.shows(X));a.shows(X);expect(worker.open(X)[0]).toBe(firstX);
    b.back();await vi.waitFor(()=>b.shows(Y));

    // B reloads: its tab leaves and a new page starts from the same URL.
    b.leave();await vi.waitFor(()=>expect(worker.open(Y)).toHaveLength(0));
    const reloaded=tab(worker,"follower_binding_0002",`${origin}/tasks?collection=${Y}`);await reloaded.ready();
    await vi.waitFor(()=>reloaded.shows(Y));a.shows(X);

    // A deep link to X in a third tab opens it there, beside the others.
    const deep=tab(worker,"follower_binding_0003",`${origin}/?collection=${X}`);await deep.ready();
    await vi.waitFor(()=>deep.shows(X));a.shows(X);reloaded.shows(Y);
    expect(worker.open(X)[0]).toBe(firstX);

    // A chooses another (pushed): no collection in A; the others keep theirs.
    await a.selection.chooseAnother();
    await vi.waitFor(()=>expect(a.snapshot()).toMatchObject({status:"unselected",selectedCollectionId:null}));
    expect(a.url()).toBeNull();deep.shows(X);reloaded.shows(Y);
    a.back();await vi.waitFor(()=>a.shows(X));
  });

  it("a tab leaving a collection another tab still shows releases its own ports, the opener's included",async()=>{
    const worker=leader();
    // A (the leader) opens X and holds its original ports; B deep-links to X.
    const a=tab(worker,"leader_binding_00001",`${origin}/?collection=${X}`,worker.primary);await a.ready();
    await vi.waitFor(()=>a.shows(X));
    const x=worker.open(X)[0]!;holds(x,["opener"]);
    const b=tab(worker,"follower_binding_0001",`${origin}/?collection=${X}`);await b.ready();
    await vi.waitFor(()=>b.shows(X));holds(x,["opener","attach1"]);

    // A switches to Y: exactly A's original ports onto X go; B keeps X open.
    await a.selection.select(Y,{history:"push"});
    await vi.waitFor(()=>a.shows(Y));
    b.shows(X);expect(worker.open(X)[0]).toBe(x);
    holds(x,["attach1"]);expect(x.detached).toBe(1);

    // A comes back to X with new ports; then B closes its tab.
    a.back();await vi.waitFor(()=>a.shows(X));holds(x,["attach1","attach2"]);
    b.leave();
    await vi.waitFor(()=>holds(x,["attach2"]));
    a.shows(X);

    // A follower that opened Y leaves while the leader shows Y: its original ports go too.
    const c=tab(worker,"follower_binding_0002",`${origin}/?collection=${Y}`);await c.ready();
    await vi.waitFor(()=>c.shows(Y));
    const y=worker.open(Y)[0]!;holds(y,["opener"]);
    await a.selection.select(Y,{history:"push"});await vi.waitFor(()=>a.shows(Y));
    await vi.waitFor(()=>expect(worker.open(X)).toHaveLength(0));
    holds(y,["opener","attach1"]);
    c.leave();
    await vi.waitFor(()=>holds(y,["attach1"]));a.shows(Y);
    for(const record of worker.opened)expect(record.strays).toBe(0);
  });

  it("access ended on one collection blocks every tab showing it, not the others; sign-out reaches every tab",async()=>{
    const worker=leader();
    const a=tab(worker,"leader_binding_00001",`${origin}/?collection=${X}`,worker.primary);await a.ready();
    const b=tab(worker,"follower_binding_0001",`${origin}/?collection=${Y}`);await b.ready();
    const c=tab(worker,"follower_binding_0002",`${origin}/?collection=${Y}`);await c.ready();
    await vi.waitFor(()=>{a.shows(X);b.shows(Y);c.shows(Y);});
    worker.open(Y)[0]!.end("forbidden");
    await vi.waitFor(()=>{
      expect(b.snapshot()).toMatchObject({status:"blocked",problem:"access_removed",selectedCollectionId:Y});
      expect(c.snapshot()).toMatchObject({status:"blocked",problem:"access_removed",selectedCollectionId:Y});
    });
    await vi.waitFor(()=>expect(worker.open(Y)).toHaveLength(0));
    a.shows(X);expect(worker.session.connection(Y)).toBeNull();

    const signedOut=await a.client.request("signOut",null,new AbortController().signal);
    expect(signedOut).toMatchObject({status:"signed_out",selectedCollectionId:null});
    for(const t of [a,b,c])await vi.waitFor(()=>expect(t.snapshot()).toMatchObject({status:"signed_out",selectedCollectionId:null}));
    expect(worker.open(X)).toHaveLength(0);expect(worker.session.heldCollections()).toEqual([]);
    for(const host of worker.hosts)expect(host.close).toHaveBeenCalled();
  });
});
