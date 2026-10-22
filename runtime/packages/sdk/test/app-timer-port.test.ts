import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAppTimerReceiver, appTimerPortClient } from "../src/app-host/timer-port.js";
import { TimersApi } from "../src/timers.js";
const scope={account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:"33333333-3333-4333-8333-333333333333"};
const grant="44444444-4444-4444-8444-444444444444",generation="55555555-5555-4555-8555-555555555555",operation="018f0000-0000-7000-8000-000000000001";
const stamp="2026-10-10T12:00:00.000Z";
const timer={id:"one",criterion_id:"reminder",fire_at:stamp,generation:1,status:"scheduled",created_at:stamp,updated_at:stamp,fired_at:null};
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
function fixture(handler:(url:string,init:RequestInit)=>Promise<Response>=async()=>Response.json({namespace:"reminders",timers:[]})) {
  const channel=new MessageChannel(),parent=new AbortController(),ui=new AbortController();let current=true;
  const request=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>handler(String(input),init!)),bearer=vi.fn(async()=>`idev_${"a".repeat(43)}`);
  const owner=attachAppTimerReceiver(channel.port1,{scope,generation,grantId:grant,cpOrigin:"https://cp.example.test",signal:parent.signal,isCurrent:()=>current,bearer,fetch:request});
  const port=appTimerPortClient(channel.port2,{scope,generation},{signal:ui.signal,onClose:()=>{}}),api=new TimersApi(port);
  cleanup.push(async()=>{api.close();await owner.close();});
  return {owner,port,api,request,bearer,parent,ui,fence:()=>{current=false;}};
}
describe("same-worker native fixed timer profile",()=>{
  it("pins exact collection/grant origin and bounds private opaque requests; no credentials or HTTP callback in UI",async()=>{
    const f=fixture();expect(await f.api.list("reminders")).toEqual({namespace:"reminders",timers:[]});
    expect(f.request).toHaveBeenCalledWith(`https://cp.example.test/v1/next/collections/${scope.collection}/background-grants/${grant}/timers/reminders`,expect.objectContaining({method:"GET",credentials:"omit",redirect:"error",cache:"no-store",referrerPolicy:"no-referrer",headers:{authorization:`Bearer idev_${"a".repeat(43)}`}}));
    expect(Object.keys(f.port).sort()).toEqual(["cancel","close","list","lookupOperation","put","reconcile","reconcileWithReceipt","registerFcm","registerWebPush","unregisterFcm","unregisterWebPush"].sort());
    expect(()=>f.api.list("../escape")).toThrow();
  });
  it("uses all fixed operation routes and exact original receipt lookup/replay without generating identity or retry",async()=>{
    const result={namespace:"reminders",timers:[timer],cancelled_ids:[]};
    const receipt={protocol_version:1,namespace:"reminders",operation_id:operation,expected_revision:0,committed_revision:1,result};
    const f=fixture(async(url,init)=>{
      if(url.endsWith(`/operations/${operation}`))return Response.json({outcome:"committed",receipt});
      if(url.endsWith("/reconcile"))return Response.json(JSON.parse(String(init.body)).recovery?receipt:result);
      if(init.method==="DELETE")return Response.json({namespace:"reminders",id:"one",cancelled:true});
      return Response.json(timer);
    });
    expect((await f.api.put({namespace:"reminders",criterionId:"reminder",timer:{id:"one",fireAt:stamp}})).id).toBe("one");
    expect((await f.api.cancel({namespace:"reminders",id:"one",generation:1})).cancelled).toBe(true);
    await f.api.reconcile({namespace:"reminders",criterionId:"reminder",timers:[{id:"one",fireAt:stamp}]});
    expect((await f.api.reconcileWithReceipt({namespace:"reminders",criterionId:"reminder",timers:[{id:"one",fireAt:stamp}],operationId:operation,expectedRevision:0})).committedRevision).toBe(1);
    expect((await f.api.lookupOperation({namespace:"reminders",operationId:operation,expectedRevision:0})).outcome).toBe("committed");
    expect(f.request).toHaveBeenCalledTimes(5);
  });
  it("refuses authority drift before dispatch and keeps caller body validation ahead of credential intake",async()=>{
    const f=fixture();await expect(f.port.put("reminders","one",{criterion_id:"reminder",fire_at:"bad"},{})).rejects.toMatchObject({code:"invalid_request"});
    expect(f.bearer).not.toHaveBeenCalled();f.fence();await expect(f.api.list("reminders")).rejects.toMatchObject({code:"unauthenticated"});expect(f.request).not.toHaveBeenCalled();
  });
  it.each(["network"])("never retries an admitted write after %s uncertainty",async variant=>{
    let f:ReturnType<typeof fixture>; f=fixture(async()=>{
      if(variant==="network")throw Error("private transport details");
      if(variant==="late_fence")f.fence();
      if(variant==="invalid_response")return new Response("not json",{headers:{"content-type":"application/json"}});
      return Response.json(timer,{status:variant==="server"?503:200});
    });
    await expect(f.api.put({namespace:"reminders",criterionId:"reminder",timer:{id:"one",fireAt:stamp}})).rejects.toMatchObject({code:"outcome_unknown"});expect(f.request).toHaveBeenCalledOnce();
  });
  it("keeps original cancellation slot until the Worker settles and drains before host shutdown",async()=>{
    let respond!:(response:Response)=>void;const f=fixture(async()=>new Promise(resolve=>{respond=resolve;})),ctrl=new AbortController();
    const mutation=f.api.put({namespace:"reminders",criterionId:"reminder",timer:{id:"one",fireAt:stamp}},{signal:ctrl.signal});
    await vi.waitFor(()=>expect(f.request).toHaveBeenCalledOnce());ctrl.abort();await expect(mutation).rejects.toMatchObject({code:"outcome_unknown"});
    await expect(f.api.list("reminders")).rejects.toMatchObject({code:"unavailable",reason:"timer_port_busy"});
    let drained=false;const close=f.owner.close().then(()=>{drained=true;});await new Promise(resolve=>setTimeout(resolve,5));expect(drained).toBe(false);
    respond(Response.json(timer));await close;expect(drained).toBe(true);
  });
  it("reports definite authorization refusal separately and refuses unsupported push composition without side effects",async()=>{
    const f=fixture(async()=>Response.json({error:{code:"timer_grant_unusable"}},{status:403}));
    await expect(f.api.put({namespace:"reminders",criterionId:"reminder",timer:{id:"one",fireAt:stamp}})).rejects.toMatchObject({code:"unauthenticated"});
    await expect(f.api.registerFcm({token:"never_sent_0123456789",criteria:["reminder"]})).rejects.toMatchObject({code:"upgrade_required",reason:"native_timer_channel_journal_unavailable"});expect(f.request).toHaveBeenCalledOnce();
  });
});
