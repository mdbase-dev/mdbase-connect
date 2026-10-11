import {AppCollectionDeleteError} from "../src/app-host/collection-delete.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {applicationDeclaration} from "../src/application/declaration.js";
import type {PackagedApplicationNativeAssets} from "../src/application/native-assets.js";
import {ApplicationWorkerHost} from "../src/application/worker-host.js";
import * as WorkerSession from "../src/application/worker-session.js";
import type {ApplicationWorkerSessionHost} from "../src/application/worker-session.js";
import {APPLICATION_WORKER_PROTOCOL as schema,APPLICATION_WORKER_MAX_ID,ApplicationWorkerError,applicationWorkerRequest,applicationWorkerProblem,type ApplicationWorkerEvent,type ApplicationWorkerAction} from "../src/application/worker-protocol.js";
import {mdbaseError} from "../src/errors.js";
const binding="original_worker_binding",origin="https://app.test",cpOrigin="https://cp.test",id="5cdfa020-c201-4da8-845a-f2cc9969eade";
const active:ApplicationWorkerHost[]=[],ports:MessagePort[]=[];
function fixture(){
  const declaration=applicationDeclaration({id,name:"TaskNotes",origin,environment:"production",manifest:{manifest_version:1,id:"dev.example.tasknotes",name:"TaskNotes",homepage:origin,redirect_uris:[`${origin}/callback`],requirements:{access:"full_collection",contracts:[],capabilities:{contract_version:2,required:["collection.read"],optional:[]}}}});
  // Declared lifecycle/packaging fixture. No CP registration, authenticated
  // build, real native/SQLite/OPFS/browser/provisioning acceptance is claimed.
  const packaged:PackagedApplicationNativeAssets={release:()=>({schema:"mdbn-app-trust/release/1",environment:"production",cpOrigin,logOrigin:"https://log.test",assetSha256:"a".repeat(64),source:{repository:"mdbase-dev/mdbase-connect",commit:"b".repeat(40),version:"fixture"},trustedRoots:[new Uint8Array(32).fill(1)],policyPins:new Uint8Array([1,2,3])}),runtime:{url:`${origin}/native/app.wasm`,sha256:"c".repeat(64),bytes:4,maxBytes:3300000},sqlite:{url:`${origin}/native/sqlite.wasm`,sha256:"d".repeat(64),bytes:4,maxBytes:1100000},initializeSqlite:vi.fn()};
  const channel=new MessageChannel(),events:ApplicationWorkerEvent[]=[],waiters:Array<()=>void>=[];ports.push(channel.port2);
  channel.port2.addEventListener("message",event=>{events.push(event.data);for(const wake of waiters.splice(0))wake();});channel.port2.start();
  const host=new ApplicationWorkerHost(channel.port1,binding,declaration,packaged,undefined);active.push(host);
  async function event(kind:ApplicationWorkerEvent[2],requestId:number){
    for(;;){const found=events.find(value=>value[2]===kind&&value[3]===requestId);if(found)return found;
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`missing ${kind}:${requestId}`)),1000);waiters.push(()=>{clearTimeout(timer);resolve();});});
    }
  }
  return{host,events,event,send:(requestId:number,action:ApplicationWorkerAction,payload:string|boolean|null=null)=>channel.port2.postMessage([schema,binding,requestId,action,payload])};
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
afterEach(async()=>{for(const host of active.splice(0))await host.stop().catch(()=>{});for(const port of ports.splice(0))port.close();vi.restoreAllMocks();});
describe("private SDK Worker bounded lifecycle",()=>{
  it("rejects malformed bindings/actions/payloads/IDs before SDK calls",()=>{
    expect(applicationWorkerRequest([schema,binding,APPLICATION_WORKER_MAX_ID,"close",null],binding)).toEqual([schema,binding,APPLICATION_WORKER_MAX_ID,"close",null]);
    for(const frame of [[schema,"foreign_binding_123",1,"start",null],[schema,binding,0,"start",null],[schema,binding,APPLICATION_WORKER_MAX_ID+1,"start",null],[schema,binding,1,"submit",null],[schema,binding,1,"start",{}],[schema,binding,1,"select",""],[schema,binding,1,"foreground","true"]])expect(()=>applicationWorkerRequest(frame,binding)).toThrow(ApplicationWorkerError);
  });
  it("rejects a nil collection hint at the Worker boundary, while retaining the optional null hint",()=>{
    expect(applicationWorkerRequest([schema,binding,1,"authorize",null],binding)[4]).toBeNull();
    expect(applicationWorkerRequest([schema,binding,1,"authorize",id],binding)[4]).toBe(id);
    expect(()=>applicationWorkerRequest([schema,binding,1,"authorize","00000000-0000-0000-0000-000000000000"],binding)).toThrow(ApplicationWorkerError);
    const del=applicationWorkerRequest([schema,binding,1,"deleteCollection",[id,"My notes"]],binding);
    expect(del[4]).toEqual([id,"My notes"]); expect(Object.isFrozen(del[4])).toBe(true);
    for(const payload of [id,[id],[id,""],["not-a-uuid","My notes"],[id,"x".repeat(1025)],[id,"My notes","extra"],[id,7]])
      expect(()=>applicationWorkerRequest([schema,binding,1,"deleteCollection",payload],binding)).toThrow(ApplicationWorkerError);
    expect(applicationWorkerProblem(new AppCollectionDeleteError("collection_delete_not_owner"))).toEqual({code:"collection_delete_not_owner"});
  });
  it("only emits allowlisted error codes, not arbitrary fields/messages/identities",()=>{
    expect(applicationWorkerProblem({code:"secret_account_identifier",reason:"private_bearer",message:"key"})).toEqual({code:"application_worker_unavailable"});
    expect(applicationWorkerProblem(new Proxy({},{getPrototypeOf(){throw new Error("private prototype failure");}}))).toEqual({code:"application_worker_unavailable"});
    expect(applicationWorkerProblem(mdbaseError("outcome_unknown","private key","private_bearer"))).toEqual({code:"outcome_unknown"});
    expect(applicationWorkerProblem(mdbaseError("unavailable","private","application_packaged_assets_unavailable"))).toEqual({code:"application_packaged_assets_unavailable"});
  });
  it("composes actual session without initialization IO; framing is native-only, not semantic READY",async()=>{
    const f=fixture(),view=await f.event("nativeSnapshot",0);expect(view[4]).toMatchObject({status:"not_started",signIn:null});
    const foreground=vi.spyOn(f.host.session,"setForeground");f.send(1,"foreground",false);expect((await f.event("reply",1))[4]).toMatchObject({ok:true});expect(foreground).toHaveBeenCalledWith(false);
    f.send(2,"close");expect((await f.event("reply",2))[4]).toMatchObject({ok:true,snapshot:{status:"closed"}});
  });
  it("retains one original slot through close/cancel cuts, drains late reply before close ack",async()=>{
    const f=fixture(),held=deferred<ReturnType<typeof f.host.session.getSnapshot>>(),entered=deferred<void>();
    vi.spyOn(f.host.session,"start").mockImplementation(()=>{entered.resolve();return held.promise;});const forget=vi.spyOn(f.host.session,"forget");
    f.send(1,"start");await entered.promise;const foreground=vi.spyOn(f.host.session,"setForeground");f.send(0,"foreground",false);await vi.waitFor(()=>expect(foreground).toHaveBeenCalledWith(false));expect(f.events.some(value=>value[2]==="reply"&&value[3]===0)).toBe(false);f.send(2,"forget",id);expect((await f.event("reply",2))[4]).toMatchObject({ok:false,problem:{code:"application_worker_busy"}});expect(forget).not.toHaveBeenCalled();
    f.send(3,"close");await new Promise(resolve=>setTimeout(resolve,10));expect(f.events.some(value=>value[2]==="reply"&&value[3]===3)).toBe(false);
    held.resolve(f.host.session.getSnapshot());expect((await f.event("reply",1))[4]).toMatchObject({ok:false,problem:{code:"application_worker_fenced"}});expect((await f.event("reply",3))[4]).toMatchObject({ok:true,snapshot:{status:"closed"}});
    expect(f.events.findIndex(value=>value[2]==="reply"&&value[3]===1)).toBeLessThan(f.events.findIndex(value=>value[2]==="reply"&&value[3]===3));
  });
  it("repeated/stale IDs fail-stop instead of replaying original operation",async()=>{
    const f=fixture(),start=vi.spyOn(f.host.session,"start").mockResolvedValue(f.host.session.getSnapshot());f.send(1,"start");await f.event("reply",1);f.send(1,"start");
    expect((await f.event("fatal",0))[4]).toEqual({code:"application_worker_binding"});await vi.waitFor(()=>expect(f.host.session.getSnapshot().status).toBe("closed"));expect(start).toHaveBeenCalledTimes(1);
  });
  it("scopes original portal ownership and transfers all present original data/control/timer ports",async()=>{
    let callbacks:ApplicationWorkerSessionHost|undefined;
    const compose=WorkerSession.applicationWorkerSession;
    vi.spyOn(WorkerSession,"applicationWorkerSession").mockImplementation((declaration,packaged,host)=>{callbacks=host;return compose(declaration,packaged,host);});
    const f=fixture();expect(callbacks).toBeDefined();const original=callbacks!;let portal:ReturnType<ApplicationWorkerSessionHost["openPortal"]>|undefined;
    vi.spyOn(f.host.session,"authorize").mockImplementation(async()=>{portal=original.openPortal();portal.navigate(`${cpOrigin}/pair/original`);return f.host.session.getSnapshot();});
    f.send(1,"authorize");expect((await f.event("portal",1))[4]).toEqual({action:"navigate",uri:`${cpOrigin}/pair/original`});await f.event("reply",1);
    portal!.close();portal!.close();await vi.waitFor(()=>expect(f.events.filter(value=>value[2]==="portal"&&value[3]===1&&"action"in value[4]&&value[4].action==="close")).toHaveLength(1));
    const data=new MessageChannel(),control=new MessageChannel(),timer=new MessageChannel();ports.push(data.port2,control.port2,timer.port2);
    vi.spyOn(f.host.session,"select").mockImplementation(async()=>{original.handoff({schema:"mdbn-app-collection/1",scope:{account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:"33333333-3333-4333-8333-333333333333"},generation:"original-generation",displayName:"Original",setupMode:"inspect",dataPort:data.port1,controlPort:control.port1,timerPort:timer.port1,people:true});return f.host.session.getSnapshot();});
    f.send(2,"select",id);const frame=await f.event("handoff",2);expect(frame[2]).toBe("handoff");if(frame[2]!=="handoff")throw new Error("missing original handoff");
    ports.push(frame[4].dataPort,frame[4].controlPort,frame[4].timerPort!);expect(frame[4].timerPort).toBeInstanceOf(MessagePort);expect(frame[4].controlPort).toBeInstanceOf(MessagePort);expect(frame[4].dataPort).toBeInstanceOf(MessagePort);await f.event("reply",2);
    await f.host.stop();expect(original.signal.aborted).toBe(true);expect(()=>portal!.navigate(`${cpOrigin}/pair/original`)).toThrow(ApplicationWorkerError);
  });
  it("failed physical stop is memoized/quarantined, never retried to manufacture success",async()=>{
    const f=fixture(),physical=vi.fn(()=>Promise.reject(new Error("private original shutdown failure")));let stopped:Promise<void>|null=null;
    vi.spyOn(f.host.session,"close").mockImplementation(()=>stopped??=physical());
    const first=f.host.stop(),second=f.host.stop();expect(first).toBe(second);await expect(first).rejects.toThrow("private original shutdown failure");
    f.send(1,"close");expect((await f.event("reply",1))[4]).toMatchObject({ok:false,problem:{code:"application_worker_stop_failed"}});expect(physical).toHaveBeenCalledTimes(1);expect(f.host.stop()).toBe(first);
  });
});
