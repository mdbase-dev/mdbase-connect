import {afterEach,describe,expect,it,vi} from "vitest";
import {ApplicationRuntime} from "../src/application/runtime.js";
import {applicationDeclaration,rebindApplicationDeclaration} from "../src/application/declaration.js";
import * as Manifest from "../src/application/manifest.js";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";
const binding="original_singleton_binding_123",declaration=applicationDeclaration({id:"org.example.app",name:"Example",origin:"https://app.test",environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],requirements:{access:"full_collection",contracts:[]}}});
const snapshot={status:"unselected",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};
const cleanup:Array<()=>Promise<void>|void>=[];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(registered=declaration,compiledManifest=Manifest.compileApplicationManifest(declaration)){
 const channel=new MessageChannel(),requests:unknown[][]=[],entered=deferred<void>(),release=vi.fn();channel.port2.addEventListener("message",event=>{requests.push(event.data);entered.resolve();});channel.port2.start();
 // Original MessageChannel and real SDK runtime/scope owners; scripted Worker
 // replies only. No registration/native physical stop/authorization proof.
 const app=new ApplicationRuntime({declaration:registered,compiledManifest,cpOrigin:"https://cp.test",port:channel.port1,binding,releaseWorker:release});cleanup.push(()=>{channel.port1.close();channel.port2.close();});
 return{app,requests,entered,release,send:(kind:string,id:number,value:unknown)=>channel.port2.postMessage([schema,binding,kind,id,value])};
}
afterEach(async()=>{for(const stop of cleanup.splice(0))await stop();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe("SDK singleton original lifecycle",()=>{
 it("never combines a native blocked code with a stale readiness detail",()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},error=vi.spyOn(console,"error").mockImplementation(()=>{});
  app.scope.getReadiness=()=>({checking:false,assessment:null,problem:{code:"readiness_fenced",detail:"connection_not_current"},facets:f.app.getSnapshot().readiness.facets});
  app.raw={...snapshot,status:"blocked",problem:"collection_migrating",selectedCollectionId:"secret-collection"};app.publish();
  expect(error).toHaveBeenCalledExactlyOnceWith("mdbase application blocked:","collection_migrating");
 });
 it("names a native blocked problem's bounded detail in the console",()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},error=vi.spyOn(console,"error").mockImplementation(()=>{});
  app.scope.getReadiness=()=>null;
  app.raw={...snapshot,status:"blocked",problem:"unavailable",problemDetail:{name:"AppCloudCopyHostError",code:"sync_stalled",stage:"read_catch_up"}};app.publish();
  expect(error).toHaveBeenLastCalledWith("mdbase application blocked:","unavailable","AppCloudCopyHostError:sync_stalled@read_catch_up");
  app.raw={...snapshot,status:"blocked",problem:"unavailable",problemDetail:{name:"AppCloudCopyHostError",code:"unavailable",stage:"device_open",cause:{name:"MdbaseError",code:"too_large"}}};app.publish();
  expect(error).toHaveBeenLastCalledWith("mdbase application blocked:","unavailable","AppCloudCopyHostError:unavailable@device_open cause=MdbaseError:too_large");
  app.raw={...snapshot,status:"blocked",problem:"unavailable",problemDetail:{name:"AppCpAuthorityError",code:"unavailable",server:{status:503,code:"unavailable",reason:null,retryAfterMs:null,updateUrl:null}}};app.publish();
  expect(error).toHaveBeenLastCalledWith("mdbase application blocked:","unavailable","AppCpAuthorityError:unavailable http=503:unavailable");
  app.raw={...snapshot,status:"blocked",problem:"unavailable",problemDetail:{name:"AppCloudCopyHostError",code:"secret value",stage:"secret/path"}};app.publish();
  expect(error).toHaveBeenLastCalledWith("mdbase application blocked:","unavailable","AppCloudCopyHostError:-");
  expect(error).toHaveBeenCalledTimes(4);
 });
 it("drops the native detail when readiness supplies the blocked problem",()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},error=vi.spyOn(console,"error").mockImplementation(()=>{});
  app.scope.getReadiness=()=>({checking:false,assessment:null,problem:{code:"configuration_unavailable"},facets:f.app.getSnapshot().readiness.facets});
  app.raw={...snapshot,status:"ready",selectedCollectionId:"secret-collection",problemDetail:{name:"AppCloudCopyHostError",code:"sync_stalled"}};app.publish();
  expect(error).toHaveBeenCalledExactlyOnceWith("mdbase application blocked:","configuration_unavailable");
  expect(f.app.getSnapshot().problemDetail).toBeUndefined();
 });
 it("logs the selected readiness problem without borrowing the assessment detail",()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},error=vi.spyOn(console,"error").mockImplementation(()=>{});
  app.scope.getReadiness=()=>({checking:false,assessment:{status:"incompatible",problem:{code:"readiness_fenced",detail:"session_closed"}},problem:{code:"configuration_unavailable"},facets:f.app.getSnapshot().readiness.facets});
  app.raw={...snapshot,status:"ready",selectedCollectionId:"secret-collection"};app.publish();
  expect(error).toHaveBeenCalledExactlyOnceWith("mdbase application blocked:","configuration_unavailable");
 });
 it("logs the safe readiness fence detail without the collection identity",()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},error=vi.spyOn(console,"error").mockImplementation(()=>{});
  let detail="connection_not_current";
  app.scope.getReadiness=()=>({checking:false,assessment:null,problem:{code:"readiness_fenced",detail},facets:f.app.getSnapshot().readiness.facets});
  app.raw={...snapshot,status:"ready",selectedCollectionId:"secret-collection"};app.publish();
  expect(error).toHaveBeenCalledWith("mdbase application blocked:","readiness_fenced","connection_not_current");
  app.publish();expect(error).toHaveBeenCalledOnce();detail="scope_closed";app.publish();
  expect(error).toHaveBeenLastCalledWith("mdbase application blocked:","readiness_fenced","scope_closed");
 });
 it("reuses the same constructor-owned canonical result after registration metadata rebinding",()=>{
  const compile=vi.spyOn(Manifest,"compileApplicationManifest"),compiled=Manifest.compileApplicationManifest(declaration);
  const registered=rebindApplicationDeclaration(declaration,{id:"55555555-5555-4555-8555-555555555555",name:declaration.name});
  const f=fixture(registered,compiled);
  expect(compile).toHaveBeenCalledOnce();expect(compile).toHaveBeenCalledWith(declaration);
  expect(Object.isFrozen(compiled)).toBe(true);expect(compiled.manifest.id).toBe(declaration.manifest.id);
  expect(f.app.getSnapshot().readiness.assessment).toBeNull();expect(f.requests).toHaveLength(0);
 });
 it("keeps the open collection's ports while an approval is in progress, and lets go once the session closes it",async()=>{
  const f=fixture(),app=f.app as unknown as {scope:{selectedId():string|null;retire():Promise<void>}},id="33333333-3333-4333-8333-333333333333";
  let held:string|null=id;app.scope.selectedId=()=>held;const retire=vi.fn(async()=>{held=null;});app.scope.retire=retire;
  const seen=(status:string)=>new Promise<void>(resolve=>{const off=f.app.subscribe(()=>{if(f.app.getNativeSnapshot().status===status){off();resolve();}});});
  let next=seen("authorizing");f.send("nativeSnapshot",0,{...snapshot,status:"authorizing",selectedCollectionId:id});await next;
  next=seen("ready");f.send("nativeSnapshot",0,{...snapshot,status:"ready",selectedCollectionId:id});await next;
  await new Promise(r=>setTimeout(r,0));expect(retire).not.toHaveBeenCalled();
  next=seen("signed_out");f.send("nativeSnapshot",0,{...snapshot,status:"signed_out"});await next;
  await vi.waitFor(()=>expect(retire).toHaveBeenCalledOnce());
 });
 it("signing out reads opening, never blocked, while this tab lets go of its open collection",async()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},id="33333333-3333-4333-8333-333333333333",statuses:string[]=[];
  const facets=f.app.getSnapshot().readiness.facets,error=vi.spyOn(console,"error").mockImplementation(()=>{});
  const ready=Object.freeze({checking:false,assessment:Object.freeze({status:"ready",problem:null}),problem:null,facets});
  const fenced=Object.freeze({checking:false,assessment:null,problem:Object.freeze({code:"readiness_fenced"}),facets});
  let readiness:unknown=ready;app.scope.getReadiness=()=>readiness;app.scope.selectedId=()=>id;
  app.scope.retire=async()=>{readiness=fenced;app.publish();await Promise.resolve();readiness=null;};
  app.raw={...snapshot,status:"ready",selectedCollectionId:id};app.publish();expect(f.app.getSnapshot().status).toBe("ready");
  f.app.subscribe(()=>statuses.push(f.app.getSnapshot().status));
  const pending=f.app.signOut();await f.entered.promise;expect(statuses).toContain("opening");
  f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"signed_out"}});expect((await pending).status).toBe("signed_out");
  expect(statuses).not.toContain("blocked");expect(error).not.toHaveBeenCalled();
 });
 it("reselecting the current blocked collection retries readiness without replacing its ports",async()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;raw:unknown;publish():void},id="33333333-3333-4333-8333-333333333333";
  vi.spyOn(console,"error").mockImplementation(()=>{});
  const facets=f.app.getSnapshot().readiness.facets;
  let readiness:unknown={checking:false,assessment:null,problem:{code:"configuration_busy_timeout"},facets};
  const connection={isCurrent:()=>true},assess=vi.fn(async()=>{readiness={checking:false,assessment:{status:"ready",problem:null},problem:null,facets};});
  app.scope.connection=()=>connection;app.scope.getReadiness=()=>readiness;app.scope.assess=assess;
  const retire=vi.fn();app.scope.retire=retire;
  app.raw={...snapshot,status:"ready",selectedCollectionId:id};app.publish();
  expect(f.app.getSnapshot().status).toBe("blocked");
  expect((await f.app.select(id)).status).toBe("ready");
  expect(assess).toHaveBeenCalledOnce();expect(retire).not.toHaveBeenCalled();expect(f.requests).toHaveLength(0);
 });
 it("native transport ready cannot promote absent current semantic/facet evidence",async()=>{
  const f=fixture(),pending=f.app.start();await f.entered.promise;f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"ready"}});const view=await pending;expect(view.status).toBe("blocked");expect(view.readiness.assessment).toBeNull();expect(f.app.connection("33333333-3333-4333-8333-333333333333")).toBeNull();
 });
 it("an opened collection reads opening, never blocked, until its first readiness assessment",async()=>{
  const f=fixture(),scope=(f.app as unknown as {scope:Record<string,unknown>}).scope,done=deferred<void>(),statuses:string[]=[];
  const ready=Object.freeze({checking:false,assessment:Object.freeze({status:"ready",problem:null}),problem:null,facets:f.app.getSnapshot().readiness.facets});
  let readiness:unknown=null;const error=vi.spyOn(console,"error").mockImplementation(()=>{});
  scope.connection=()=>({});scope.getReadiness=()=>readiness;scope.assess=async()=>{await done.promise;readiness=ready;};
  f.app.subscribe(()=>statuses.push(f.app.getSnapshot().status));
  const pending=f.app.start();await f.entered.promise;
  f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"ready",selectedCollectionId:"33333333-3333-4333-8333-333333333333"}});
  await vi.waitFor(()=>expect(statuses).toContain("opening"));done.resolve();
  expect((await pending).status).toBe("ready");expect(statuses).not.toContain("blocked");expect(error).not.toHaveBeenCalled();
 });
 it("setup in flight reads opening while a facet re-checks, never blocked by the native setup reason",async()=>{
  const f=fixture(),app=f.app as unknown as {scope:Record<string,unknown>;publish():void;raw:unknown},statuses:string[]=[];
  const facets=f.app.getSnapshot().readiness.facets,error=vi.spyOn(console,"error").mockImplementation(()=>{});
  const setup=Object.freeze({checking:false,assessment:Object.freeze({status:"setup_required",problem:Object.freeze({code:"readiness_contract_missing"})}),problem:Object.freeze({code:"readiness_contract_missing"}),facets});
  const partial=Object.freeze({checking:false,assessment:null,problem:Object.freeze({code:"readiness_contract_missing"}),facets});
  const ready=Object.freeze({checking:false,assessment:Object.freeze({status:"ready",problem:null}),problem:null,facets});
  let readiness:unknown=setup;app.scope.getReadiness=()=>readiness;
  app.raw={...snapshot,status:"setup_required",selectedCollectionId:"33333333-3333-4333-8333-333333333333"};app.publish();
  expect(f.app.getSnapshot().status).toBe("setup_required");
  f.app.subscribe(()=>statuses.push(f.app.getSnapshot().status));
  app.scope.applySetup=async()=>{readiness=partial;app.publish();await Promise.resolve();readiness=ready;};
  const done=await f.app.applySetup({} as never);
  expect(statuses).toContain("opening");expect(statuses).not.toContain("blocked");expect(done.status).toBe("ready");expect(error).not.toHaveBeenCalled();
 });
 it("retains enclosing singleton action after caller abort until original Worker reply drains",async()=>{
  const f=fixture(),caller=new AbortController(),pending=f.app.start({signal:caller.signal}),refused=expect(pending).rejects.toMatchObject({code:"application_worker_fenced"});await f.entered.promise;caller.abort();await new Promise(r=>setTimeout(r,10));await expect(f.app.start()).rejects.toMatchObject({code:"application_busy"});expect(f.requests).toHaveLength(1);f.send("reply",1,{ok:true,snapshot});await refused;
 });
 it("does not publish closed/release Worker before original terminal ACK",async()=>{
  const f=fixture(),closed=f.app.close();expect(f.app.close()).toBe(closed);expect(f.app.getSnapshot().status).toBe("blocked");expect(f.app.getSnapshot().problem).toBe("application_closing");await f.entered.promise;expect(f.release).not.toHaveBeenCalled();f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"closed"}});await closed;expect(f.app.getSnapshot().status).toBe("closed");expect(f.release).toHaveBeenCalledOnce();
 });
 it("failed physical stop remains memoized/quarantined, never a closed success",async()=>{
  const f=fixture(),closed=f.app.close(),refused=expect(closed).rejects.toMatchObject({code:"application_stop_failed"});await f.entered.promise;f.send("reply",1,{ok:false,problem:{code:"application_worker_stop_failed"}});await refused;expect(f.app.close()).toBe(closed);expect(f.app.getSnapshot()).toMatchObject({status:"blocked",problem:"application_stop_failed"});expect(f.release).not.toHaveBeenCalled();
 });
 it("reserves popup synchronously and blocked popup performs no Worker authorization IO",async()=>{
  const f=fixture(),open=vi.fn(()=>null);vi.stubGlobal("window",{open});const pending=f.app.authorize();expect(open).toHaveBeenCalledOnce();expect(f.requests).toHaveLength(0);await expect(pending).rejects.toMatchObject({reason:"application_popup_blocked"});expect(f.app.getSnapshot().status).toBe("not_started");
 });
 it("unlock is refused in this tab, with no Worker request, unless this tab shows a locked collection and the secret is well formed",async()=>{
  const f=fixture(),id="33333333-3333-4333-8333-333333333333",encode=vi.spyOn(TextEncoder.prototype,"encode");
  await expect(f.app.unlock(id,{password:"correct horse battery staple"})).rejects.toMatchObject({code:"invalid_request",reason:"unlock_not_locked"});
  // The bytes made for the refused call are wiped too.
  expect(encode.mock.results.at(-1)!.value.every((value:number)=>value===0)).toBe(true);
  const app=f.app as unknown as {raw:unknown;publish():void};
  app.raw={...snapshot,status:"needs_unlock",selectedCollectionId:id,unlock:{mode:"password",unlocking:false,problem:null}};app.publish();
  expect(f.app.getSnapshot()).toMatchObject({status:"needs_unlock",selectedCollectionId:id,unlock:{mode:"password",unlocking:false,problem:null}});
  // Another collection than the locked one this tab shows.
  await expect(f.app.unlock("44444444-4444-4444-8444-444444444444",{password:"correct horse battery staple"})).rejects.toMatchObject({code:"invalid_request",reason:"unlock_not_locked"});
  for(const secret of [null,"correct horse battery staple",{},{password:""},{password:7},{recoveryKey:null},{password:"a",recoveryKey:"b"},{password:"x".repeat(4097)},{recoveryKey:"é".repeat(2049)}])
   await expect(f.app.unlock(id,secret as never)).rejects.toMatchObject({code:"invalid_request",reason:"unlock_secret_invalid"});
  await expect(f.app.unlock(7 as never,{password:"correct horse battery staple"})).rejects.toMatchObject({code:"invalid_request",reason:"unlock_secret_invalid"});
  expect(f.requests).toHaveLength(0);
 });
 it("unlock sends the secret once as bytes, wipes this tab's copy at once, and a wrong secret resolves still locked with its problem",async()=>{
  const f=fixture(),id="33333333-3333-4333-8333-333333333333",app=f.app as unknown as {raw:unknown;publish():void};
  const locked={...snapshot,status:"needs_unlock",selectedCollectionId:id,unlock:{mode:"password",unlocking:false,problem:null}};
  app.raw=locked;app.publish();
  const encode=vi.spyOn(TextEncoder.prototype,"encode"),pending=f.app.unlock(id,{password:"correct horse battery staple"});
  await f.entered.promise;
  expect(f.requests).toHaveLength(1);
  const [,,requestId,action,payload]=f.requests[0] as [string,string,number,string,[string,string,Uint8Array]];
  expect(action).toBe("unlock");expect(payload[0]).toBe(id);expect(payload[1]).toBe("password");
  expect(new TextDecoder().decode(payload[2])).toBe("correct horse battery staple");
  // The tab's own copy is already zero while the Worker still runs.
  const mine=encode.mock.results.at(-1)!.value as Uint8Array;expect(mine).toHaveLength(28);expect(mine.every(value=>value===0)).toBe(true);
  f.send("reply",requestId,{ok:true,snapshot:{...locked,unlock:{mode:"password",unlocking:false,problem:"wrong_secret"}}});
  const view=await pending;
  expect(view).toMatchObject({status:"needs_unlock",selectedCollectionId:id,unlock:{mode:"password",unlocking:false,problem:"wrong_secret"}});
  expect(JSON.stringify(view)).not.toContain("correct horse");expect(f.app.connection(id)).toBeNull();
  // A recovery key travels the same way.
  const again=f.app.unlock(id,{recoveryKey:"AAAA-BBBB-CCCC"});await vi.waitFor(()=>expect(f.requests).toHaveLength(2));
  const second=f.requests[1] as [string,string,number,string,[string,string,Uint8Array]];expect(second[4][1]).toBe("recoveryKey");expect(new TextDecoder().decode(second[4][2])).toBe("AAAA-BBBB-CCCC");
  f.send("reply",second[2],{ok:false,problem:{code:"refused"}});await expect(again).rejects.toMatchObject({code:"refused"});
  expect((encode.mock.results.at(-1)!.value as Uint8Array).every(value=>value===0)).toBe(true);
 });
 it("preserves genuine string problem codes such as enrollment outcome_unknown",async()=>{
  const f=fixture(),pending=f.app.start();await f.entered.promise;f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"authorizing",problem:"outcome_unknown"}});await expect(pending).resolves.toMatchObject({status:"authorizing",problem:"outcome_unknown"});expect(f.release).not.toHaveBeenCalled();
 });
});
