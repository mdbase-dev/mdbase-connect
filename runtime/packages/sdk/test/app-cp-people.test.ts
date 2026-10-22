import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCpPeopleAuthority } from "../src/app-host/cp-people.js";
import type { AppCpSession } from "../src/app-host/cp-authority.js";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});
function fixture(fetchImpl:typeof globalThis.fetch=async()=>json({issuer:"https://id.example",subject:"acct_exact",name:"Alice"})){
  let current=true;
  const session:AppCpSession={cpOrigin:"https://cp.example",logOrigin:"https://log.example",directOrigins:[],collection:id(1),deviceId:id(2),connectorId:id(3),endpoint:37,isCurrent:()=>current,connectorBearer:vi.fn(async()=>"idev_private")};
  const fetch=vi.fn(fetchImpl),authority=new AppCpPeopleAuthority(session,{fetch});
  return {session,fetch,authority,stale:()=>{current=false;}};
}
afterEach(()=>vi.useRealTimers());
describe("pinned CP people metadata",()=>{
  it.each(["idev_private","ct_private"])("uses fixed GETs and registered-device binding for %s, no cookies/redirects/payload",async bearer=>{
    const f=fixture();f.session.connectorBearer=async()=>bearer;
    await f.authority.request("identity");await f.authority.request("members");
    expect(f.authority.collection).toBe(id(1));
    expect(f.fetch.mock.calls.map(([url])=>url)).toEqual([`https://cp.example/v1/authorities/${id(1)}/identity?device_id=${id(2)}`,`https://cp.example/v1/authorities/${id(1)}/members?device_id=${id(2)}`]);
    for(const [,init] of f.fetch.mock.calls){expect(init).toMatchObject({method:"GET",headers:{authorization:`Bearer ${bearer}`},credentials:"omit",redirect:"error",cache:"default",referrerPolicy:"no-referrer"});expect(init).not.toHaveProperty("body");}
  });
  it.each(["https://user:password@cp.example"])("refuses unapproved origin %s",async origin=>{
    const f=fixture();Object.assign(f.session,{cpOrigin:origin});expect(()=>new AppCpPeopleAuthority(f.session)).toThrow();
  });
  it("allows only explicitly enabled loopback HTTP",()=>{
    const f=fixture();Object.assign(f.session,{cpOrigin:"http://127.0.0.1:9090"});expect(()=>new AppCpPeopleAuthority(f.session,{allowLoopbackHttp:true})).not.toThrow();
    Object.assign(f.session,{cpOrigin:"http://localhost.attacker.example"});expect(()=>new AppCpPeopleAuthority(f.session,{allowLoopbackHttp:true})).toThrow();
  });
  it.each(["at_portable","ct_\nheader"])("refuses inappropriate or unsafe credential %# before network",async bearer=>{
    const f=fixture();f.session.connectorBearer=async()=>bearer;await expect(f.authority.request("identity")).rejects.toMatchObject({reason:"people_binding"});expect(f.fetch).not.toHaveBeenCalled();
  });
  it("fences scope retirement during bearer await, without sending credential",async()=>{
    const f=fixture();f.session.connectorBearer=async()=>{f.stale();return "idev_private";};
    await expect(f.authority.request("identity")).rejects.toMatchObject({reason:"people_fenced"});expect(f.fetch).not.toHaveBeenCalled();
  });
  it("close aborts in-flight fetch and rejects a late reply",async()=>{
    let release!:(response:Response)=>void;
    const f=fixture(async()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.authority.request("identity");await vi.waitFor(()=>expect(f.fetch).toHaveBeenCalledOnce());
    f.authority.close();release(json({name:"late"}));
    await expect(pending).rejects.toMatchObject({reason:"people_fenced"});expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("caller cancellation aborts the request and rejects ignored-abort late replies",async()=>{
    let release!:(response:Response)=>void;
    const f=fixture(async()=>new Promise(resolve=>{release=resolve;})),ctrl=new AbortController();
    const pending=f.authority.request("identity",{signal:ctrl.signal});await vi.waitFor(()=>expect(f.fetch).toHaveBeenCalledOnce());
    ctrl.abort();release(json({name:"late"}));await expect(pending).rejects.toMatchObject({name:"AbortError"});expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
  it("bounds declared and streamed bodies, rejects invalid UTF8/JSON",async()=>{
    for(const response of [new Response("{}",{headers:{"content-length":"1048577"}}),new Response("x".repeat(1048577)),new Response(new Uint8Array([0xff])),new Response("not json"),json([])]){
      const f=fixture(async()=>response);await expect(f.authority.request("identity")).rejects.toMatchObject({reason:"people_response"});
    }
  });
  it("fences while streaming before exposing any late metadata",async()=>{
    let stale=()=>{};
    const body=new ReadableStream<Uint8Array>({pull(ctrl){stale();ctrl.enqueue(new TextEncoder().encode("{}"));ctrl.close();}});
    const f=fixture(async()=>new Response(body));stale=f.stale;
    await expect(f.authority.request("identity")).rejects.toMatchObject({reason:"people_fenced"});
  });
  it.each([[401,"anything","unauthenticated","people_fenced"],[403,"collection_scope","forbidden","people_access"],[403,"people_permission_declined","forbidden","people_permission_declined"],[404,"not_found","upgrade_required","people_unsupported"]] as const)("maps status %s/%s without mistaking authorization failure for optional decline",async(status,code,error,reason)=>{
    const f=fixture(async()=>json({error:{code,message:"private details"}},status));await expect(f.authority.request("members")).rejects.toMatchObject({code:error,reason});
  });
  it("identity decline remains fatal, never an optional member omission",async()=>{
    const f=fixture(async()=>json({error:{code:"people_permission_declined"}},403));await expect(f.authority.request("identity")).rejects.toMatchObject({reason:"people_access"});
  });
  it("sanitizes arbitrary network/redirect errors",async()=>{
    const f=fixture(async()=>{throw Error("idev_private secret URL");});await expect(f.authority.request("identity")).rejects.toThrow("people metadata is unavailable");
    const redirect=fixture(async()=>json({},302));await expect(redirect.authority.request("identity")).rejects.toMatchObject({reason:"people_response"});
  });
  it("deadline aborts real signal-aware transport, no retry",async()=>{
    vi.useFakeTimers();const f=fixture(async(_url,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});}));
    const pending=f.authority.request("identity"),assertion=expect(pending).rejects.toMatchObject({reason:"people_response"});
    await vi.advanceTimersByTimeAsync(15001);await assertion;expect(f.fetch).toHaveBeenCalledOnce();
  });
});
