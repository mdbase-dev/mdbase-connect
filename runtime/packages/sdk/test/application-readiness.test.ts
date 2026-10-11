import {afterEach,describe,expect,it,vi} from "vitest";
import {MdbaseClient} from "../src/client.js";
import {MdbasePeopleClient} from "../src/people.js";
import {MemoryReplica} from "../src/testing/index.js";
import {ApplicationReadiness,type ApplicationReadinessFacetSource} from "../src/application/readiness.js";
import type {MdbaseApplicationConnection,MdbaseApplicationFacetSnapshot} from "../src/application/entry.js";
const collection="33333333-3333-4333-8333-333333333333",generation="44444444-4444-4444-8444-444444444444";
const ready:MdbaseApplicationFacetSnapshot={checking:false,assessment:{status:"ready",problem:null},problem:null};
const cleanup:Array<()=>Promise<void>|void>=[];
function source(value=ready):ApplicationReadinessFacetSource{return{getSnapshot:()=>value,subscribe:()=>()=>{},refresh:vi.fn(async()=>value),close:vi.fn()};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
async function fixture(facets:Partial<Record<"configuration"|"files"|"people"|"notifications",ApplicationReadinessFacetSource>>={}){
  // Actual SDK client, explicit declared facet producers. Not native/READY proof.
  const client=await MdbaseClient.connect({app:{name:"Fixture",version:"1"},connector:new MemoryReplica({collection}).connector()}),lifetime=new AbortController();let current=true;
  const connection:MdbaseApplicationConnection={id:collection,generation,displayName:"Fixture",scope:{collection,account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222"},records:client,files:client.files,people:new MdbasePeopleClient(client,{collection,isCurrent:()=>current,request:async()=>{throw Error("unused fixture authority");}}),isCurrent:()=>current};
  const assess=new ApplicationReadiness({connection,nativeRequirements:null,signal:lifetime.signal,isCurrent:()=>current,...facets});cleanup.push(async()=>{await assess.close().catch(()=>{});client.close();});
  return{assess,client,lifetime,retire:()=>{current=false;}};
}
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
describe("SDK current aggregate readiness",()=>{
  it("successful facet stand-ins cannot invent native v2 evidence or aggregate READY",async()=>{
    const f=await fixture({configuration:source(),files:source(),people:source(),notifications:source()});await f.assess.refresh();const view=f.assess.getSnapshot();expect(view.assessment).toBeNull();expect(view.facets.capabilities.assessment).toBeNull();expect(view.facets.contracts.assessment).toBeNull();expect(view.problem?.code).toBe("readiness_unsupported");
  });
  it("missing source and failed/checking reads stay null, never an empty ready policy",async()=>{
    const f=await fixture({people:source({checking:true,assessment:null,problem:null}),notifications:source({checking:false,assessment:null,problem:{code:"notifications_unsupported"}})}),view=f.assess.getSnapshot();expect(view.checking).toBe(true);expect(view.assessment).toBeNull();expect(view.facets.files.problem?.code).toBe("files_unsupported");
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
});
