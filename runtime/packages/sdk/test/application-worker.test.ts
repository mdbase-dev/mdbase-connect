import {AppInstallationSignInError} from "../src/app-host/installation-sign-in.js";
import {AppCollectionDeleteError} from "../src/app-host/collection-delete.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {applicationDeclaration} from "../src/application/declaration.js";
import type {PackagedApplicationNativeAssets} from "../src/application/native-assets.js";
import {ApplicationWorkerHost,applicationWorkerReplyProblem} from "../src/application/worker-host.js";
import {AppCloudCopyBootstrapError} from "../src/app-host/cloud-copy-bootstrap.js";
import {AppCollectionSetupError} from "../src/app-host/collection-setup-journal.js";
import {describeError} from "../src/describe-error.js";
import {ApplicationWorkerReplyError} from "../src/application/worker-client.js";
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
  const host=new ApplicationWorkerHost(channel.port1,binding,declaration,packaged,undefined,null);active.push(host);
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
    for(const frame of [[schema,"foreign_binding_123",1,"start",null],[schema,binding,0,"start",null],[schema,binding,APPLICATION_WORKER_MAX_ID+1,"start",null],[schema,binding,1,"submit",null],[schema,binding,1,"start",{}],[schema,binding,1,"select",""],[schema,binding,1,"foreground","true"],[schema,binding,1,"approvalClosed",true],[schema,binding,0,"approvalClosed",false],[schema,binding,0,"approvalClosed",null]])expect(()=>applicationWorkerRequest(frame,binding)).toThrow(ApplicationWorkerError);
    expect(applicationWorkerRequest([schema,binding,0,"approvalClosed",true],binding)).toEqual([schema,binding,0,"approvalClosed",true]);
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
    expect(applicationWorkerProblem(new AppInstallationSignInError("unavailable"))).toEqual({code:"unavailable"});
    expect(applicationWorkerProblem({code:"secret_account_identifier",reason:"private_bearer",message:"key"})).toEqual({code:"application_worker_unavailable"});
    expect(applicationWorkerProblem(new Proxy({},{getPrototypeOf(){throw new Error("private prototype failure");}}))).toEqual({code:"application_worker_unavailable"});
    expect(applicationWorkerProblem(mdbaseError("outcome_unknown","private key","private_bearer"))).toEqual({code:"outcome_unknown"});
    expect(applicationWorkerProblem(mdbaseError("unavailable","private","application_packaged_assets_unavailable"))).toEqual({code:"application_packaged_assets_unavailable"});
  });
  it("keeps a native outcome_unknown typed across the reply, not 'this browser can't run the app'",()=>{
    for(const error of [new AppCloudCopyBootstrapError("outcome_unknown"),new AppCollectionSetupError("outcome_unknown")]){
      const problem=applicationWorkerReplyProblem(error);expect(problem).toEqual({code:"outcome_unknown"});
      expect(describeError(new ApplicationWorkerReplyError(problem.code))).toMatchObject({key:"outcome_unknown",title:"Not sure that worked",action:"resolve_outcome"});
    }
    expect(applicationWorkerReplyProblem(new AppCollectionSetupError("binding"))).toEqual({code:"binding"});
    expect(applicationWorkerReplyProblem(new Error("private"))).toEqual({code:"application_worker_unavailable"});
  });
  it("composes actual session without initialization IO; framing is native-only, not semantic READY",async()=>{
    const f=fixture(),view=await f.event("nativeSnapshot",0);expect(view[4]).toMatchObject({status:"not_started",signIn:null});
    const foreground=vi.spyOn(f.host.session,"setForeground");f.send(1,"foreground",false);expect((await f.event("reply",1))[4]).toMatchObject({ok:true});expect(foreground).toHaveBeenCalledWith(false);
    f.send(2,"close");expect((await f.event("reply",2))[4]).toMatchObject({ok:true,snapshot:{status:"closed"}});
  });
  it("forwards a one-way approvalClosed signal to the session without a reply",async()=>{
    const f=fixture();await f.event("nativeSnapshot",0);const closed=vi.spyOn(f.host.session,"approvalWindowClosed");
    f.send(0,"approvalClosed",true);await vi.waitFor(()=>expect(closed).toHaveBeenCalledOnce());expect(f.events.some(value=>value[2]==="reply"||value[2]==="fatal")).toBe(false);
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
    vi.spyOn(f.host.session,"openCollection").mockImplementation(async()=>{original.handoff({schema:"mdbn-app-collection/1",scope:{account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:id},generation:"original-generation",displayName:"Original",setupMode:"inspect",dataPort:data.port1,controlPort:control.port1,timerPort:timer.port1,people:true});return f.host.session.getSnapshot();});
    f.send(2,"select",id);const frame=await f.event("handoff",2);expect(frame[2]).toBe("handoff");if(frame[2]!=="handoff")throw new Error("missing original handoff");
    ports.push(frame[4].dataPort,frame[4].controlPort,frame[4].timerPort!);expect(frame[4].timerPort).toBeInstanceOf(MessagePort);expect(frame[4].controlPort).toBeInstanceOf(MessagePort);expect(frame[4].dataPort).toBeInstanceOf(MessagePort);await f.event("reply",2);
    await f.host.stop();expect(original.signal.aborted).toBe(true);expect(()=>portal!.navigate(`${cpOrigin}/pair/original`)).toThrow(ApplicationWorkerError);
  });
  it("serves follower tabs: snapshots, own ports to the collection they show, turns not busy, foreground across tabs, close detaches only that tab",async()=>{
    let callbacks:ApplicationWorkerSessionHost|undefined;
    const compose=WorkerSession.applicationWorkerSession;
    vi.spyOn(WorkerSession,"applicationWorkerSession").mockImplementation((declaration,packaged,host)=>{callbacks=host;return compose(declaration,packaged,host);});
    const f=fixture();await f.event("nativeSnapshot",0);
    const scope={account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:id};
    const handoff=()=>{const d=new MessageChannel(),c=new MessageChannel();ports.push(d.port1,c.port1);return Object.freeze({schema:"mdbn-app-collection/1" as const,scope,generation:"g1",displayName:"Notes",setupMode:"inspect" as const,dataPort:d.port2,controlPort:c.port2});};
    let open=false;const setForeground=vi.fn(),detach=vi.fn(),attach=vi.fn(handoff);
    vi.spyOn(f.host.session,"viewFor").mockImplementation(selected=>({...f.host.session.getSnapshot(),status:open&&selected===id?"ready":"unselected",selectedCollectionId:selected}));
    const connection={scope,generation:"g1",isCurrent:()=>true,setForeground,attach,detach};
    vi.spyOn(f.host.session,"connection").mockImplementation(collection=>open&&collection===id?connection:null);
    vi.spyOn(f.host.session,"heldCollections").mockImplementation(()=>open?[id]:[]);
    const follower=new MessageChannel(),seen:ApplicationWorkerEvent[]=[];ports.push(follower.port2);
    follower.port2.onmessage=event=>seen.push(event.data);
    const fb="follower_binding_0001",fsend=(requestId:number,action:ApplicationWorkerAction,payload:string|boolean|null=null)=>follower.port2.postMessage([schema,fb,requestId,action,payload]);
    f.host.attach(follower.port1,fb);
    await vi.waitFor(()=>expect(seen.some(value=>value[2]==="nativeSnapshot")).toBe(true));
    const gate=deferred<void>();
    const openCollection=vi.spyOn(f.host.session,"openCollection").mockImplementation(async()=>{if(!open){callbacks!.handoff(handoff());await gate.promise;open=true;}return f.host.session.getSnapshot();});
    vi.spyOn(f.host.session,"refreshCollectionList").mockImplementation(async()=>f.host.session.getSnapshot());
    f.send(1,"select",id);fsend(1,"select",id);await f.event("handoff",1);
    gate.resolve();await f.event("reply",1);
    // The follower's request waited its turn; the collection was already open,
    // so it got its own ports (not the reply) onto the same one.
    await vi.waitFor(()=>expect(seen.find(value=>value[2]==="reply"&&value[3]===1)?.[4]).toMatchObject({ok:true}));
    await vi.waitFor(()=>expect(seen.find(value=>value[2]==="handoff")?.[3]).toBe(0));
    expect(attach).toHaveBeenCalledOnce();expect(openCollection).toHaveBeenCalledTimes(2);
    const handoffIndex=seen.findIndex(value=>value[2]==="handoff");
    const beforeHandoff=seen.slice(0,handoffIndex).reverse().find(value=>value[2]==="nativeSnapshot");
    expect(beforeHandoff?.[4]).toMatchObject({status:"ready",selectedCollectionId:id});
    // Visible in any tab keeps the collection in the foreground.
    f.send(0,"foreground",false);
    await vi.waitFor(()=>expect(setForeground).toHaveBeenLastCalledWith(false));
    fsend(0,"foreground",true);
    await vi.waitFor(()=>expect(setForeground).toHaveBeenLastCalledWith(true));
    // Back online (or focused) while already visible: the connection still wakes.
    const woken=setForeground.mock.calls.length;fsend(0,"foreground",true);
    await vi.waitFor(()=>expect(setForeground).toHaveBeenCalledTimes(woken+1));
    fsend(2,"close");
    await vi.waitFor(()=>expect(seen.find(value=>value[2]==="reply"&&value[3]===2)?.[4]).toMatchObject({ok:true,snapshot:{status:"closed"}}));
    expect(detach).toHaveBeenCalledOnce();
    await vi.waitFor(()=>expect(setForeground).toHaveBeenLastCalledWith(false));
    f.send(2,"refreshCollections");expect((await f.event("reply",2))[4]).toMatchObject({ok:true});
  });
  it("failed physical stop is memoized/quarantined, never retried to manufacture success",async()=>{
    const f=fixture(),physical=vi.fn(()=>Promise.reject(new Error("private original shutdown failure")));let stopped:Promise<void>|null=null;
    vi.spyOn(f.host.session,"close").mockImplementation(()=>stopped??=physical());
    const first=f.host.stop(),second=f.host.stop();expect(first).toBe(second);await expect(first).rejects.toThrow("private original shutdown failure");
    f.send(1,"close");expect((await f.event("reply",1))[4]).toMatchObject({ok:false,problem:{code:"application_worker_stop_failed"}});expect(physical).toHaveBeenCalledTimes(1);expect(f.host.stop()).toBe(first);
  });
});
