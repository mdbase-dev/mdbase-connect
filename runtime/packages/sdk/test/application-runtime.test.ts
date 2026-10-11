import {afterEach,describe,expect,it,vi} from "vitest";
import {ApplicationRuntime} from "../src/application/runtime.js";
import {applicationDeclaration} from "../src/application/declaration.js";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";
const binding="original_singleton_binding_123",declaration=applicationDeclaration({id:"org.example.app",name:"Example",origin:"https://app.test",environment:"lab",manifest:{manifest_version:1,id:"org.example.app",name:"Example",homepage:"https://app.test",redirect_uris:["https://app.test/callback"],requirements:{access:"full_collection",contracts:[]}}});
const snapshot={status:"unselected",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};
const cleanup:Array<()=>Promise<void>|void>=[];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function fixture(){
 const channel=new MessageChannel(),requests:unknown[][]=[],entered=deferred<void>(),release=vi.fn();channel.port2.addEventListener("message",event=>{requests.push(event.data);entered.resolve();});channel.port2.start();
 // Original MessageChannel and real SDK runtime/scope owners; scripted Worker
 // replies only. No registration/native physical stop/authorization proof.
 const app=new ApplicationRuntime({declaration,cpOrigin:"https://cp.test",port:channel.port1,binding,releaseWorker:release});cleanup.push(()=>{channel.port1.close();channel.port2.close();});
 return{app,requests,entered,release,send:(kind:string,id:number,value:unknown)=>channel.port2.postMessage([schema,binding,kind,id,value])};
}
afterEach(async()=>{for(const stop of cleanup.splice(0))await stop();vi.unstubAllGlobals();});
describe("SDK singleton original lifecycle",()=>{
 it("native transport ready cannot promote absent current semantic/facet evidence",async()=>{
  const f=fixture(),pending=f.app.start();await f.entered.promise;f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"ready"}});const view=await pending;expect(view.status).toBe("blocked");expect(view.readiness.assessment).toBeNull();expect(f.app.connection("33333333-3333-4333-8333-333333333333")).toBeNull();
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
 it("preserves genuine string problem codes such as enrollment outcome_unknown",async()=>{
  const f=fixture(),pending=f.app.start();await f.entered.promise;f.send("reply",1,{ok:true,snapshot:{...snapshot,status:"authorizing",problem:"outcome_unknown"}});await expect(pending).resolves.toMatchObject({status:"authorizing",problem:"outcome_unknown"});expect(f.release).not.toHaveBeenCalled();
 });
});
