// `snapshot.sync` in the application entry: one object from the replica's
// status, its ledger and link, the session's transport health and the browser.
import {afterEach,expect,it,vi} from "vitest";
import {MdbaseConnect} from "../src/application/entry.js";
import type {ApplicationRuntime} from "../src/application/runtime.js";
import type {SyncStatus} from "../src/wire.js";
import type {WriteLedgerSnapshot} from "../src/write-ledger.js";

const origin="https://app.test",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

function open(){
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  const page=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
  vi.stubGlobal("window",page);vi.stubGlobal("location",page.location);vi.stubGlobal("Worker",class{});
  const browser:{onLine?:boolean;storage:unknown}={storage:{persisted:async()=>true}};
  vi.stubGlobal("navigator",browser);
  const entry=new MdbaseConnect({id:"org.example.app",name:"Example",origin,environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
    redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}},{privateCollections:false});
  // Stand-in runtime/replica IO; the entry, its subscriptions, clock and timers are real.
  let status:SyncStatus={mode:"synced",confirmedThrough:1,headKnown:1,pending:0,holds:0,unresolved:0,connection:"online",incidents:[]};
  let writes:WriteLedgerSnapshot={pending:[],rejected:[],saveState:"saved",restored:true};
  let link:"open"|"reconnecting"|"closed"="open";
  let onStatus:(next:SyncStatus)=>void=()=>{},onWrites=()=>{},onLink=()=>{};
  const setTransportDeferred=vi.fn();
  const records={get status(){return status;},get link(){return link;},setTransportDeferred,
    onStatus:(listener:typeof onStatus)=>{onStatus=listener;return()=>{onStatus=()=>{};};},
    onLink:(listener:()=>void)=>{onLink=listener;return()=>{onLink=()=>{};};},
    ledger:{subscribe:(listener:()=>void)=>{onWrites=listener;return()=>{onWrites=()=>{};};},getSnapshot:()=>writes}};
  let raw:Record<string,unknown>={status:"ready",signIn:{state:"paired",accountId:"account"},collections:[{collectionId:id,displayName:"A",role:"owner"}],
    selectedCollectionId:id,problem:null,transport:null,live:true,readiness:{checking:false,assessment:null,problem:null,facets:{}}};
  const connection={id,isCurrent:()=>true,records};
  const runtime={getSnapshot:()=>raw,getNativeSnapshot:()=>raw,connection:()=>connection,close:async()=>{}};
  (entry as unknown as {runtime:ApplicationRuntime}).runtime=runtime as unknown as ApplicationRuntime;
  const app=entry.application();
  return {app,page,browser,setTransportDeferred,sync:()=>app.getSnapshot().sync!,
    status:(next:Partial<SyncStatus>)=>{status={...status,...next};onStatus(status);},
    writes:(next:Partial<WriteLedgerSnapshot>)=>{writes={...writes,...next};onWrites();},
    link:(next:typeof link)=>{link=next;onLink();},
    session:(next:Record<string,unknown>)=>{raw={...raw,...next};}};
}

it("is one object, with the ledger inside it and no separate writes field",async()=>{
  const t=open();
  expect(t.sync()).toEqual({state:"saved",connection:"online",health:null,live:true,pending:0,pendingFor:null,
    writes:{pending:[],rejected:[],saveState:"saved",restored:true},attention:[],conflicts:0,holds:0,incidents:[]});
  expect(Object.isFrozen(t.sync())).toBe(true);
  expect(t.app.getSnapshot()).not.toHaveProperty("writes");
  expect(t.app.getSnapshot().sync).toBe(t.app.getSnapshot().sync);
  await t.app.close();
});

it("tells subscribers when a save stops being brief and when it becomes long, with one clock per pending run",async()=>{
  const t=open(),seen:(string|null)[]=[];
  t.app.subscribe(()=>seen.push(t.sync().pendingFor));
  // The ledger knows the write before the replica counts it: the clock starts there.
  t.writes({pending:[{mutationId:"0192f3a4-6000-7abc-8def-0123456789ab",records:[],createdAt:1,state:"pending"}],saveState:"saving"});
  expect(t.sync()).toMatchObject({state:"saving",pending:1,pendingFor:"moment"});
  vi.advanceTimersByTime(1_000);t.status({pending:2});expect(t.sync()).toMatchObject({pending:2,pendingFor:"moment"});
  vi.advanceTimersByTime(999);expect(t.sync().pendingFor).toBe("moment");
  vi.advanceTimersByTime(1);expect(seen.at(-1)).toBe("while");
  vi.advanceTimersByTime(27_999);expect(t.sync().pendingFor).toBe("while");
  vi.advanceTimersByTime(1);expect(seen.at(-1)).toBe("long");
  expect(vi.getTimerCount()).toBe(0);
  // Nothing pending ends the run; the next change starts a new one.
  t.writes({pending:[],saveState:"saved"});t.status({pending:0});expect(t.sync()).toMatchObject({state:"saved",pendingFor:null});
  t.status({pending:1});expect(t.sync().pendingFor).toBe("moment");
  await t.app.close();expect(vi.getTimerCount()).toBe(0);
});

it("goes offline when the browser does, and holds pending writes on the device meanwhile",async()=>{
  const t=open(),states:string[]=[];
  t.app.subscribe(()=>states.push(t.sync().state));
  expect(t.sync().state).toBe("saved");expect(t.setTransportDeferred).toHaveBeenLastCalledWith(false);
  t.browser.onLine=false;t.page.dispatchEvent(new Event("offline"));
  expect(states.at(-1)).toBe("offline");expect(t.sync()).toMatchObject({connection:"offline",health:null});
  expect(t.setTransportDeferred).toHaveBeenLastCalledWith(true);
  t.status({pending:1});expect(t.sync().state).toBe("saved_on_device");
  t.browser.onLine=true;t.page.dispatchEvent(new Event("online"));
  expect(states.at(-1)).toBe("saving");expect(t.setTransportDeferred).toHaveBeenLastCalledWith(false);
  // A failed request says more than the browser: the service is not answering.
  t.session({transport:{kind:"server_busy",retryAfterMs:1_000}});
  expect(t.sync()).toMatchObject({state:"saved_on_device",connection:"reconnecting",health:"server_busy"});
  expect(t.setTransportDeferred).toHaveBeenLastCalledWith(true);
  t.session({transport:null});t.status({pending:0});expect(t.sync().state).toBe("saved");
  t.link("reconnecting");expect(states.at(-1)).toBe("reconnecting");
  await t.app.close();
});

it("puts what needs the person first: a refusal, a rejected write, a storage warning",async()=>{
  const t=open();
  t.session({problem:"update_required"});
  expect(t.sync()).toMatchObject({state:"attention",attention:["update_required"]});
  t.session({problem:null});
  t.writes({rejected:[{mutationId:"0192f3a4-6000-7abc-8def-0123456789ab",records:[],createdAt:1,state:"rejected"}],saveState:"rejected"});
  expect(t.sync()).toMatchObject({state:"attention",attention:["rejected"],writes:{rejected:[{state:"rejected"}]}});
  t.writes({rejected:[],saveState:"saved"});
  // Storage the browser may clear: the same fact as `saveWarning`, in the same object.
  t.status({pending:1,connection:"offline"});
  expect(t.app.getSnapshot().saveWarning).toBe("storage_may_be_evicted");
  expect(t.sync()).toMatchObject({state:"attention",attention:["storage_may_be_evicted"],connection:"offline",pending:1});
  t.status({pending:0});expect(t.sync()).toMatchObject({state:"offline",attention:[]});
  await t.app.close();
});
