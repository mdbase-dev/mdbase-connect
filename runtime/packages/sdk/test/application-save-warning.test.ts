import {afterEach,expect,it,vi} from "vitest";
import {MdbaseConnect} from "../src/application/entry.js";
import type {ApplicationRuntime} from "../src/application/runtime.js";
import type {SyncStatus} from "../src/wire.js";
import {describeError} from "../src/describe-error.js";
import {UNSYNCED_STORAGE_WARNING} from "../src/app-host/status.js";

const origin="https://app.test",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

it("never flashes for fast online/connecting edits; warns at 30s or offline and clears at zero (replica count, not ledger/transport)",async()=>{
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});
  const page=Object.assign(new EventTarget(),{location:{origin,href:`${origin}/`},history:{state:null,pushState(){},replaceState(){}}});
  vi.stubGlobal("window",page);vi.stubGlobal("location",page.location);vi.stubGlobal("Worker",class{});
  const persist=vi.fn(async()=>false);
  vi.stubGlobal("navigator",{storage:{persisted:async()=>false,persist}});
  const entry=new MdbaseConnect({id:"org.example.app",name:"Example",origin,environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:origin,
    redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[]}}},{privateCollections:false});
  // Stand-in runtime/replica IO; the entry, subscriptions, clock, timer and copy are real.
  let status:SyncStatus={mode:"synced",confirmedThrough:1,headKnown:1,pending:0,holds:0,unresolved:0,connection:"online",incidents:[]};
  let onStatus:(next:SyncStatus)=>void=()=>{};
  const records={get status(){return status;},onStatus:(listener:typeof onStatus)=>{onStatus=listener;return()=>{onStatus=()=>{};};},setTransportDeferred:vi.fn(),
    ledger:{subscribe:()=>()=>{},getSnapshot:()=>({pending:[],rejected:[],unknown:[]})}};
  const raw={status:"ready",signIn:{state:"paired",accountId:"account"},collections:[{collectionId:id,displayName:"A",role:"owner"}],selectedCollectionId:id,problem:null,
    // A transient transport problem must NOT make an online replica warn early.
    transport:{kind:"server_busy"},readiness:{checking:false,assessment:null,problem:null,facets:{}}};
  const connection={id,isCurrent:()=>true,records};
  const runtime={getSnapshot:()=>raw,getNativeSnapshot:()=>raw,connection:()=>connection,close:async()=>{}};
  (entry as unknown as {runtime:ApplicationRuntime}).runtime=runtime as unknown as ApplicationRuntime;
  const app=entry.application(),warning=()=>app.getSnapshot().saveWarning;
  const change=(pending:number,connection:SyncStatus["connection"]="online")=>{status={...status,pending,connection};onStatus(status);};
  expect(warning()).toBeNull();
  await Promise.resolve();await Promise.resolve();expect(persist).toHaveBeenCalledOnce();
  const warnings:(string|null|undefined)[]=[];app.subscribe(()=>warnings.push(warning()));
  change(1);expect(warning()).toBeNull();
  vi.advanceTimersByTime(29_999);expect(warning()).toBeNull();
  change(0);vi.advanceTimersByTime(1);expect(warning()).toBeNull();
  expect(warnings.every(value=>value===null)).toBe(true);
  // The zero-pending event resets the clock even without a snapshot reader.
  change(1);vi.advanceTimersByTime(20_000);change(2);vi.advanceTimersByTime(9_999);expect(warning()).toBeNull();
  vi.advanceTimersByTime(1);expect(warnings.at(-1)).toBe("storage_may_be_evicted");
  change(0);expect(warning()).toBeNull();
  change(1,"offline");expect(warning()).toBe("storage_may_be_evicted");
  change(0,"offline");expect(warning()).toBeNull();
  change(1,"connecting");expect(warning()).toBeNull();
  vi.advanceTimersByTime(500);change(1,"online");expect(warning()).toBeNull();
  change(0);expect(warning()).toBeNull();
  // Reconnect does not reset the continuous pending clock or warn early.
  change(1,"connecting");vi.advanceTimersByTime(29_999);expect(warning()).toBeNull();
  vi.advanceTimersByTime(1);expect(warning()).toBe("storage_may_be_evicted");
  change(1,"online");expect(warning()).toBe("storage_may_be_evicted");
  change(0,"connecting");expect(warning()).toBeNull();
  // Persistence without installation suppresses even long-lived disconnected edits.
  persist.mockResolvedValue(true);
  (entry as unknown as {storagePolicy:{persistent:boolean;installed:boolean}}).storagePolicy={persistent:true,installed:false};
  change(2,"offline");vi.advanceTimersByTime(30_000);expect(warning()).toBeNull();
  change(0);expect(warning()).toBeNull();
  change(1);await app.close();expect(vi.getTimerCount()).toBe(0);
  expect(describeError("storage_may_be_evicted")).toMatchObject({title:"Not synced yet",message:UNSYNCED_STORAGE_WARNING});
});
