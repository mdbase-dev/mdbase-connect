import {afterEach,describe,expect,it,vi} from "vitest";
import {MdbaseClient} from "../src/client.js";
import {mdbaseError} from "../src/errors.js";
import {clientFrame,problem as problemCodec} from "../src/wire.js";
import type {FramePort} from "../src/transport/port.js";
import {describeError} from "../src/describe-error.js";
import {MdbasePeopleClient} from "../src/people.js";
import {MemoryReplica} from "../src/testing/index.js";
import {ApplicationReadiness,type ApplicationReadinessFacetSource} from "../src/application/readiness.js";
import type {MdbaseApplicationConnection,MdbaseApplicationFacetSnapshot} from "../src/application/entry.js";
import * as CollectionReadiness from "../src/app-host/collection-readiness.js";
import {createApplicationFileReadiness} from "../src/application/file-readiness.js";
import {createApplicationNotificationReadiness} from "../src/application/notification-readiness.js";
import {MDBASE_TIMER_FIRED_CONTRACT} from "@mdbase-dev/connect-protocol";
const collection="33333333-3333-4333-8333-333333333333",generation="44444444-4444-4444-8444-444444444444";
const ready:MdbaseApplicationFacetSnapshot={checking:false,assessment:{status:"ready",problem:null},problem:null};
const cleanup:Array<()=>Promise<void>|void>=[];
function source(value=ready):ApplicationReadinessFacetSource{return{getSnapshot:()=>value,subscribe:()=>()=>{},refresh:vi.fn(async()=>value),close:vi.fn()};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
async function fixture(facets:Partial<Record<"configuration"|"files"|"people"|"notifications",ApplicationReadinessFacetSource>>={},nativeRequirements:ConstructorParameters<typeof ApplicationReadiness>[0]["nativeRequirements"]=null){
  // Actual SDK client, explicit declared facet producers. Not native/READY proof.
  const original=new MemoryReplica({collection}).connector();let port!:FramePort;
  const client=await MdbaseClient.connect({app:{name:"Fixture",version:"1"},reconnect:false,connector:{description:original.description,async open(hello,signal){const opened=await original.open(hello,signal);port=opened.port;return opened;}}}),lifetime=new AbortController();let current=true;
  const connection:MdbaseApplicationConnection={id:collection,generation,displayName:"Fixture",scope:{collection,account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222"},records:client,files:client.files,people:new MdbasePeopleClient(client,{collection,isCurrent:()=>current,request:async()=>{throw Error("unused fixture authority");}}),isCurrent:()=>current&&client.link==="open"};
  const assess=new ApplicationReadiness({connection,nativeRequirements,signal:lifetime.signal,isCurrent:()=>current,...facets});cleanup.push(async()=>{await assess.close().catch(()=>{});client.close();});
  return{assess,client,connection,lifetime,retire:()=>{current=false;},end:(error:ReturnType<typeof mdbaseError>)=>port.onframe!(clientFrame.enc({kind:"push",type:"closed",payload:problemCodec.enc(error.toProblem())}))};
}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
describe("SDK current aggregate readiness",()=>{
  it.each(["scope_closed","scope_aborted","observer_not_current","connection_not_current","collection_mismatch","currentness_check_failed"])("identifies %s without exposing identities or exception text",async detail=>{
    const f=await fixture();
    if(detail==="scope_closed")await f.assess.close();
    else if(detail==="scope_aborted")f.lifetime.abort();
    else if(detail==="observer_not_current")f.retire();
    else if(detail==="connection_not_current")vi.spyOn(f.connection,"isCurrent").mockReturnValue(false);
    else if(detail==="collection_mismatch")vi.spyOn(f.client,"collection","get").mockReturnValue("other-secret-collection");
    else vi.spyOn(f.connection,"isCurrent").mockImplementation(()=>{throw Error("secret exception text");});
    expect(f.assess.getSnapshot().problem).toEqual({code:"readiness_fenced",detail});
    await expect(f.assess.refresh()).rejects.toMatchObject({code:"application_readiness_fenced",detail});
  });
  it.each(["collection","generation"] as const)("identifies a mismatched native witness %s",async field=>{
    vi.spyOn(CollectionReadiness,"createAppCollectionReadiness").mockImplementation((_client,_declared,binding)=>({start:async()=>{},close:async()=>{},subscribe:()=>()=>{},
      getSnapshot:()=>({checking:false,problem:null,assessment:{status:"ready",problem:null,witness:{collection:binding.collection,generation:binding.generation,resources:[],[field]:"secret-wrong-identity"}}})}) as unknown as CollectionReadiness.AppCollectionReadiness);
    const f=await fixture({configuration:source(),files:source()},{capabilityContractVersion:2,requiredNativeCapabilities:[],contracts:[]});
    const expected={code:"readiness_fenced",detail:`native_witness_${field}_mismatch`};
    expect(f.assess.getSnapshot().problem).toEqual(expected);
    expect(f.assess.getSnapshot().facets.contracts.problem).toEqual(expected);
  });
  it("identifies the gating facet that fences readiness",async()=>{
    vi.spyOn(CollectionReadiness,"createAppCollectionReadiness").mockImplementation((_client,_declared,binding)=>({start:async()=>{},close:async()=>{},subscribe:()=>()=>{},
      getSnapshot:()=>({checking:false,problem:null,assessment:{status:"ready",problem:null,witness:{collection:binding.collection,generation:binding.generation,resources:[]}}})}) as unknown as CollectionReadiness.AppCollectionReadiness);
    const f=await fixture({configuration:source({checking:false,assessment:null,problem:{code:"readiness_fenced"}})},{capabilityContractVersion:2,requiredNativeCapabilities:[],contracts:[]});
    expect(f.assess.getSnapshot().problem).toEqual({code:"readiness_fenced",detail:"configuration_facet"});
  });
  it.each([
    {code:"upgrade_required" as const,reason:"incompatible_version",problem:"update_required",action:"update_app"},
    {code:"unavailable" as const,reason:"file_read_failed",problem:"file_read_failed",action:"retry"},
  ])("preserves native closing $reason instead of describing it as indefinite busy",async({code,reason,problem,action})=>{
    const f=await fixture();
    f.end(mdbaseError(code,"native session ended",reason));
    expect(f.client.link).toBe("closed");expect(f.client.linkProblem).toMatchObject({code,reason});
    const view=f.assess.getSnapshot();
    expect(view.problem?.code).toBe(problem);
    expect(describeError(view)).toMatchObject({action,transient:false});
    f.lifetime.abort();
    expect(f.assess.getSnapshot().problem?.code).toBe("readiness_fenced");
  });
  it("successful facet stand-ins cannot invent native v2 evidence or aggregate READY",async()=>{
    const f=await fixture({configuration:source(),files:source(),people:source(),notifications:source()});await f.assess.refresh();const view=f.assess.getSnapshot();expect(view.assessment).toBeNull();expect(view.facets.capabilities.assessment).toBeNull();expect(view.facets.contracts.assessment).toBeNull();expect(view.problem?.code).toBe("readiness_unsupported");
  });
  it("missing source and failed/checking reads stay null, never an empty ready policy",async()=>{
    const f=await fixture({configuration:source({checking:true,assessment:null,problem:null}),notifications:source({checking:false,assessment:null,problem:{code:"notifications_unsupported"}})}),view=f.assess.getSnapshot();expect(view.checking).toBe(true);expect(view.assessment).toBeNull();expect(view.facets.files.problem?.code).toBe("files_unsupported");
  });
  it("sequences original CONTROL facet READs and caller abort cannot release the occupied refresh",async()=>{
    const gate=deferred<MdbaseApplicationFacetSnapshot>(),entered=deferred<void>(),order:string[]=[],configuration=source(),files=source(),people=source(),notifications=source();configuration.refresh=vi.fn(()=>{order.push("configuration");entered.resolve();return gate.promise;});files.refresh=vi.fn(async()=>{order.push("files");return ready;});people.refresh=vi.fn(async()=>{order.push("people");return ready;});notifications.refresh=vi.fn(async()=>{order.push("notifications");return ready;});
    const f=await fixture({configuration,files,people,notifications}),caller=new AbortController(),pending=f.assess.refresh({signal:caller.signal}),rejected=expect(pending).rejects.toMatchObject({code:"application_readiness_fenced"});await entered.promise;caller.abort();await expect(f.assess.refresh()).rejects.toMatchObject({code:"application_readiness_busy"});expect(order).toEqual(["configuration"]);gate.resolve(ready);await rejected;expect(order).toEqual(["configuration","files","people","notifications"]);expect(configuration.refresh).toHaveBeenCalledWith();
  });
  it("installs refresh slot before invoking synchronous observers",async()=>{
    const f=await fixture({configuration:source()}),calls:Promise<unknown>[]=[];let observed=false;f.assess.subscribe(()=>{if(!observed){observed=true;calls.push(f.assess.refresh().catch(error=>error));}});await f.assess.refresh();expect(await calls[0]).toMatchObject({code:"application_readiness_busy"});
  });
  it("close fences before observers, memoizes, drains original READ and never closes borrowed records",async()=>{
    const gate=deferred<MdbaseApplicationFacetSnapshot>(),entered=deferred<void>(),configuration=source();configuration.refresh=()=>{entered.resolve();return gate.promise;};const f=await fixture({configuration}),pending=f.assess.refresh(),rejected=expect(pending).rejects.toMatchObject({code:"application_readiness_fenced"});await entered.promise;let recursive:Promise<void>|undefined;f.assess.subscribe(()=>{recursive=f.assess.close();});const closed=f.assess.close();expect(recursive).toBe(closed);expect(f.assess.close()).toBe(closed);expect(f.assess.getSnapshot().assessment).toBeNull();expect(f.client.link).toBe("open");gate.resolve(ready);await rejected;await closed;expect(f.client.link).toBe("open");
  });
  it("getter-side retirement fences every facet at final delivery",async()=>{
    const files=source(),f=await fixture({files});files.getSnapshot=()=>{f.retire();return ready;};const view=f.assess.getSnapshot();expect(view.assessment).toBeNull();expect(view.problem?.code).toBe("readiness_fenced");for(const facet of Object.values(view.facets))expect(facet.problem?.code).toBe("readiness_fenced");
  });
  it("a READY collection stays READY while a concurrent change is re-checked; a settled non-ready result replaces it",async()=>{
    // Regression (LAB 2026-10-12): a second device's change flipped readiness to
    // checking/readiness_changed/configuration_changed and blocked the open app.
    vi.spyOn(CollectionReadiness,"createAppCollectionReadiness").mockImplementation((_client,_declared,binding)=>({start:async()=>{},close:async()=>{},subscribe:()=>()=>{},
      getSnapshot:()=>({checking:false,problem:null,assessment:{status:"ready",problem:null,witness:{collection:binding.collection,generation:binding.generation,resources:[]}}})}) as unknown as CollectionReadiness.AppCollectionReadiness);
    let value:MdbaseApplicationFacetSnapshot=ready;const listeners=new Set<()=>void>();
    const configuration:ApplicationReadinessFacetSource={getSnapshot:()=>value,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l);},refresh:async()=>value,close:()=>{}};
    const set=(next:MdbaseApplicationFacetSnapshot)=>{value=next;for(const l of listeners)l();};
    const f=await fixture({configuration,files:source(),people:source()},{} as never);await f.assess.refresh();
    expect(f.assess.getSnapshot()).toMatchObject({checking:false,problem:null,assessment:{status:"ready"}});
    for(const next of [{checking:true,assessment:null,problem:null},{checking:false,assessment:null,problem:{code:"configuration_changed"}},{checking:false,assessment:null,problem:{code:"readiness_busy"}}]){
      set(next);expect(f.assess.getSnapshot()).toMatchObject({checking:false,problem:null,assessment:{status:"ready"}});
    }
    set({checking:false,assessment:{status:"setup_required",problem:null},problem:null});
    expect(f.assess.getSnapshot().assessment?.status).toBe("setup_required");
    // A background re-check keeps the settled setup_required (no flicker), never READY.
    set({checking:true,assessment:null,problem:null});expect(f.assess.getSnapshot()).toMatchObject({checking:false,assessment:{status:"setup_required"}});
    set({checking:false,assessment:null,problem:{code:"configuration_unavailable"}});expect(f.assess.getSnapshot().problem?.code).toBe("configuration_unavailable");
    f.retire();expect(f.assess.getSnapshot().problem?.code).toBe("readiness_fenced");
  });
  it("opens READY with the real files and notification producers when reminders are left off",async()=>{
    // Regression (LAB 2026-10-12): no files producer and blocking notifications
    // left every opened collection "blocked", shown as "Something went wrong".
    vi.spyOn(CollectionReadiness,"createAppCollectionReadiness").mockImplementation((_client,_declared,binding)=>({start:async()=>{},close:async()=>{},subscribe:()=>()=>{},
      getSnapshot:()=>({checking:false,problem:null,assessment:{status:"ready",problem:null,witness:{collection:binding.collection,generation:binding.generation,resources:[]}}})}) as unknown as CollectionReadiness.AppCollectionReadiness);
    const isCurrent=()=>true,scope={collection,account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222"};
    const reminders=createApplicationNotificationReadiness({notifications:{declaration:{criteria:[{id:"task.reminder",event:MDBASE_TIMER_FIRED_CONTRACT,presentation:{title:"Reminder"}}]}},timers:undefined,scope,generation,signal:new AbortController().signal,isCurrent});
    const required={required:["list","read","add"] as const,optional:[]};
    const open=await fixture({configuration:source(),people:source(),notifications:reminders,files:createApplicationFileReadiness({declaration:required,scope:"collection",grant:()=>({actions:["list","read","add","replace"],scope:{kind:"collection"}}),isCurrent})},{} as never);
    const view=await open.assess.refresh();
    expect(view.problem).toBeNull();expect(view.assessment).toMatchObject({status:"ready",problem:null});
    // Advisory facets settle after READY (P5).
    await vi.waitFor(()=>expect(open.assess.getSnapshot().facets.notifications.problem?.code).toBe("notifications_consent_required"));
    const narrow=await fixture({configuration:source(),people:source(),files:createApplicationFileReadiness({declaration:required,scope:"collection",grant:()=>({actions:["list","read"],scope:{kind:"collection"}}),isCurrent})},{} as never);
    expect((await narrow.assess.refresh()).assessment).toMatchObject({status:"incompatible",problem:{code:"files_access_missing"}});
  });
});
