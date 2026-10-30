import {afterEach,describe,expect,it,vi} from "vitest";
import {ApplicationWorkerClient,type ApplicationWorkerClientOwner} from "../src/application/worker-client.js";
import {APPLICATION_WORKER_PROTOCOL as schema} from "../src/application/worker-protocol.js";
import type {AppWebSignInSnapshot} from "../src/app-host/web-sign-in-session.js";
const binding="original_worker_binding_123",snapshot:AppWebSignInSnapshot={status:"unselected",collections:[],selectedCollectionId:null,signIn:null,problem:null,timing:null};
const cleanup:Array<()=>void>=[];
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{promise,resolve};}
function fixture(handoff:ApplicationWorkerClientOwner["handoff"]=async()=>{}, nativeAuthorization?:ApplicationWorkerClientOwner["nativeAuthorization"]){
  const channel=new MessageChannel(),requests:unknown[][]=[],release=vi.fn(),snapshots=vi.fn(),arrived=deferred<void>();
  channel.port2.addEventListener("message",event=>{requests.push(event.data);arrived.resolve();});channel.port2.start();
  const client=new ApplicationWorkerClient(channel.port1,binding,{snapshot:snapshots,handoff,releaseWorker:release,...(nativeAuthorization?{nativeAuthorization}:{})}),caller=new AbortController();
  cleanup.push(()=>{channel.port1.close();channel.port2.close();});
  return{client,caller,requests,release,snapshots,arrived,send:(kind:string,id:number,value:unknown)=>channel.port2.postMessage([schema,binding,kind,id,value])};
}
afterEach(()=>{for(const close of cleanup.splice(0))close();});
// Genuine MessageChannel. Explicit SDK lifecycle/HELLO stand-ins, not native
// shutdown qualification. Termination callback is observed, never invoked early.
describe("SDK original UI Worker request ownership",()=>{
  it.each([["future_stage",null],["replaying","replaying"],[null,null],[undefined,null]])("normalizes display-only progress %s without failing the original operation",async(progress,expected)=>{
    const f=fixture(),pending=f.client.request("start",null,f.caller.signal);await f.arrived.promise;
    f.send("reply",1,{ok:true,snapshot:{...snapshot,openingProgress:progress}});
    await expect(pending).resolves.toMatchObject({status:"unselected",openingProgress:expected});
    expect(f.release).not.toHaveBeenCalled();
  });
  it.each([123,{},[]])("still rejects malformed progress types without exposing their contents",async(progress)=>{
    const f=fixture(),pending=f.client.request("start",null,f.caller.signal),rejected=expect(pending).rejects.toMatchObject({code:"application_worker_binding"});await f.arrived.promise;
    f.send("reply",1,{ok:true,snapshot:{...snapshot,openingProgress:progress}});await rejected;
  });
  it("routes Native preparation on the original portal after its authorize reply, with no second operation slot",async()=>{
    const app="11111111-1111-4111-8111-111111111111",nativeAuthorization=vi.fn(async()=>({applicationId:app,authorizationId:app,manifestDigest:"cc".repeat(32)}));
    const f=fixture(undefined,nativeAuthorization),portal={navigate:vi.fn(),close:vi.fn()},pending=f.client.request("authorize",null,f.caller.signal,portal);
    await f.arrived.promise;f.send("reply",1,{ok:true,snapshot});await pending;
    f.send("nativeAuthorization",1,{rpc:1,action:"prepare",value:{requestId:app,accountId:app,appId:app,challenge:"ab".repeat(32)}});
    await vi.waitFor(()=>expect(nativeAuthorization).toHaveBeenCalledOnce());
    await vi.waitFor(()=>expect(f.requests[1]).toMatchObject([schema,binding,"nativeAuthorizationReply",1,{rpc:1,ok:true}]));
    expect(portal.navigate).not.toHaveBeenCalled();expect(portal.close).not.toHaveBeenCalled();
  });
  it("caller abort rejects delivery but retains original slot until reply",async()=>{
    const f=fixture(),pending=f.client.request("start",null,f.caller.signal),rejected=expect(pending).rejects.toMatchObject({code:"application_worker_fenced"});await f.arrived.promise;f.caller.abort();await rejected;
    await expect(f.client.request("start",null,new AbortController().signal)).rejects.toMatchObject({code:"application_worker_busy"});expect(f.requests).toHaveLength(1);
    f.send("reply",1,{ok:true,snapshot});await new Promise(r=>setTimeout(r,10));const next=f.client.request("start",null,new AbortController().signal);await new Promise(r=>setTimeout(r,10));expect(f.requests[1]?.[2]).toBe(2);f.send("reply",2,{ok:true,snapshot});await expect(next).resolves.toMatchObject({status:"unselected"});
  });
  it("dispatches original handoff before reply and drains it before releasing slot",async()=>{
    const gate=deferred<void>(),entered=deferred<void>(),handoff=vi.fn<ApplicationWorkerClientOwner["handoff"]>(async(_value,_caller)=>{entered.resolve();await gate.promise;}),f=fixture(handoff),pending=f.client.request("select","collection-fixture",f.caller.signal);
    await f.arrived.promise;f.send("handoff",1,{declaredFixture:true});await entered.promise;f.send("reply",1,{ok:true,snapshot});await new Promise(r=>setTimeout(r,10));
    await expect(f.client.request("start",null,f.caller.signal)).rejects.toMatchObject({code:"application_worker_busy"});expect(handoff.mock.calls[0]?.[1]).toBe(f.caller.signal);gate.resolve();await expect(pending).resolves.toBeDefined();
  });
  it("terminal close waits for ACK AND original handoff drain before Worker release",async()=>{
    const gate=deferred<void>(),entered=deferred<void>(),f=fixture(async()=>{entered.resolve();await gate.promise;}),pending=f.client.request("start",null,f.caller.signal),rejected=expect(pending).rejects.toMatchObject({code:"application_worker_fenced"});
    await f.arrived.promise;f.send("handoff",1,{declaredFixture:true});await entered.promise;const closed=f.client.close();expect(f.client.close()).toBe(closed);await rejected;await new Promise(r=>setTimeout(r,10));expect(f.requests[1]?.[3]).toBe("close");
    f.send("reply",1,{ok:false,problem:{code:"application_worker_fenced"}});f.send("reply",2,{ok:true,snapshot:{...snapshot,status:"closed"}});await new Promise(r=>setTimeout(r,10));expect(f.release).not.toHaveBeenCalled();gate.resolve();await closed;expect(f.release).toHaveBeenCalledOnce();
  });
  it("failed physical stop is memoized with original Worker retained",async()=>{
    const f=fixture(),closed=f.client.close(),failed=expect(closed).rejects.toMatchObject({code:"application_worker_stop_failed"});await f.arrived.promise;f.send("reply",1,{ok:false,problem:{code:"application_worker_stop_failed"}});await failed;expect(f.client.close()).toBe(closed);expect(f.release).not.toHaveBeenCalled();expect(f.requests).toHaveLength(1);
  });
  it("refuses a successful close reply that does not certify terminal native state",async()=>{
    const f=fixture(),closed=f.client.close(),failed=expect(closed).rejects.toMatchObject({code:"application_worker_binding"});await f.arrived.promise;f.send("reply",1,{ok:true,snapshot});await failed;expect(f.release).not.toHaveBeenCalled();expect(f.client.close()).toBe(closed);
  });
  it("visibility is one-way ID0 even while original operation is held",async()=>{
    const f=fixture(),pending=f.client.request("start",null,f.caller.signal);await f.arrived.promise;f.client.setForeground(false);await new Promise(r=>setTimeout(r,10));expect(f.requests[1]).toEqual([schema,binding,0,"foreground",false]);f.send("reply",1,{ok:true,snapshot});await pending;
  });
  it("reports a person-closed held approval window once, and never a window the SDK closed",async()=>{
    vi.useFakeTimers();try{
      const f=fixture();let gone=false;const portal={navigate:vi.fn(),close:vi.fn(()=>{gone=true;}),get closed(){return gone;}};
      const pending=f.client.request("authorize",null,f.caller.signal,portal);await vi.advanceTimersByTimeAsync(0);f.send("reply",1,{ok:true,snapshot});await vi.advanceTimersByTimeAsync(0);await pending;
      await vi.advanceTimersByTimeAsync(1500);expect(f.requests).toHaveLength(1);
      gone=true;await vi.advanceTimersByTimeAsync(1500);expect(f.requests.slice(1)).toEqual([[schema,binding,0,"approvalClosed",true]]);
      const g=fixture();gone=false;const next=g.client.request("authorize",null,g.caller.signal,portal);await vi.advanceTimersByTimeAsync(0);g.send("reply",1,{ok:true,snapshot});await vi.advanceTimersByTimeAsync(0);await next;
      g.send("portal",1,{action:"close"});await vi.advanceTimersByTimeAsync(1500);expect(portal.close).toHaveBeenCalledOnce();expect(g.requests).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });
  it("keeps original portal reservation after authorization reply for original close",async()=>{
    const f=fixture(),portal={navigate:vi.fn(),close:vi.fn()},pending=f.client.request("authorize",null,f.caller.signal,portal);await f.arrived.promise;f.send("portal",1,{action:"navigate",uri:"https://cp.fixture.test/approve"});f.send("reply",1,{ok:true,snapshot});await pending;expect(portal.navigate).toHaveBeenCalledOnce();f.send("portal",1,{action:"close"});await new Promise(r=>setTimeout(r,10));expect(portal.close).toHaveBeenCalledOnce();
  });
});
