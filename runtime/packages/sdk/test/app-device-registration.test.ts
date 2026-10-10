import { describe,expect,it,vi } from "vitest";
import { AppCpDeviceRegistration, type AppCpDeviceSession } from "../src/app-host/device-registration.js";
import type { AppWasmRuntime } from "../src/app-host/wasm-runtime.js";
const NOW=1_800_000_000_000;
const custody=()=>({signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3),envelope:Buffer.from([4,5,6])});
function fixture(kind:"mobile"|"app-runtime"="app-runtime") {
  const session:AppCpDeviceSession={connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:"88888888-8888-8888-8888-888888888888",cpOrigin:"https://cp.example.test",kind,isCurrent:()=>true,connectorBearer:vi.fn(async()=>"connector-fixture")};
  const runtime={deviceCustodyCurrent:vi.fn(()=>true),signCpEnrol:vi.fn((_challenge:Uint8Array)=>({...custody(),signature:new Uint8Array(64).fill(7)})),acknowledgeDeviceRegistration:vi.fn(),retireLog:vi.fn()} as unknown as AppWasmRuntime;
  const persistence={pending:vi.fn(async(_envelope:Uint8Array)=>{}),registered:vi.fn(async()=>{})};let count=0;
  const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify(count++===0?{challenge:"11".repeat(32),expires_at:NOW+60_000}:{device_id:session.deviceId}),{headers:{"content-type":"application/json"}}));
  const owned=custody(),reg=new AppCpDeviceRegistration(runtime,session,owned,persistence,{fetch,now:()=>NOW});return {session,runtime,persistence,fetch,owned,reg,signal:new AbortController().signal};
}
describe("fixed protected first-party cp-enrol HTTP consumer",()=>{
  it.each(["mobile","app-runtime"] as const)("registers actual %s tuple with persist-before-HTTP and response-receipt-before-adoption",async kind=>{
    const f=fixture(kind),receipt=await f.reg.register({signal:f.signal});expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.runtime.acknowledgeDeviceRegistration).toHaveBeenCalledWith(receipt);expect([...f.owned.envelope]).toEqual([4,5,6]);
    expect(f.persistence.pending.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]!);expect(f.persistence.registered.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.runtime.acknowledgeDeviceRegistration).mock.invocationCallOrder[0]!);
    const [url,init]=f.fetch.mock.calls[1]!;expect(url).toBe("https://cp.example.test/v1/next/devices");expect(init).toMatchObject({redirect:"error",credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});const body=JSON.parse(init!.body as string);expect(body).toEqual({device_id:f.session.deviceId,kind,challenge:"11".repeat(32),sign_pk:"01".repeat(32),kem_pk:"02".repeat(32),noise_pk:"03".repeat(32),sig:"07".repeat(64)});
    const input=vi.mocked(f.runtime.signCpEnrol).mock.calls[0]![0];expect(input.every(b=>b===0)).toBe(true);expect(f.runtime.retireLog).not.toHaveBeenCalled();
    await expect(f.reg.register({signal:f.signal})).rejects.toThrow("fenced");expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it("uncertain pending custody write retires identity before network and never wipes/retries storage",async()=>{
    const f=fixture();f.persistence.pending.mockRejectedValueOnce(new Error("secret storage detail"));await expect(f.reg.register({signal:f.signal})).rejects.toThrow("unavailable");expect(f.fetch).not.toHaveBeenCalled();expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);await expect(f.reg.register({signal:f.signal})).rejects.toThrow();expect(f.persistence.pending).toHaveBeenCalledTimes(1);
  });
  it("uncertain completed receipt write preserves remote outcome and denies native adoption",async()=>{
    const f=fixture();f.persistence.registered.mockRejectedValueOnce(new Error("secret storage detail"));await expect(f.reg.register({signal:f.signal})).rejects.toThrow("unavailable");expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled();expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
  it.each(["pending","bearer","challenge","register","receipt"])("fences identity changes after await at %s",async stage=>{
    const f=fixture(),change=()=>{f.session.isCurrent=()=>false;};
    if(stage==="pending")f.persistence.pending.mockImplementationOnce(async()=>{change();});
    if(stage==="bearer")vi.mocked(f.session.connectorBearer).mockImplementationOnce(async()=>{change();return "fixture";});
    if(stage==="challenge")f.fetch.mockImplementationOnce(async()=>{change();return new Response(JSON.stringify({challenge:"11".repeat(32),expires_at:NOW+60_000}));});
    if(stage==="register")f.fetch.mockImplementationOnce(async()=>new Response(JSON.stringify({challenge:"11".repeat(32),expires_at:NOW+60_000}))).mockImplementationOnce(async()=>{change();return new Response(JSON.stringify({device_id:f.session.deviceId}));});
    if(stage==="receipt")f.persistence.registered.mockImplementationOnce(async()=>{change();});
    await expect(f.reg.register({signal:f.signal})).rejects.toThrow("fenced");expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled();expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
  it("fences native owner loss after await even while authenticated session is still current",async()=>{
    const f=fixture();f.persistence.pending.mockImplementationOnce(async()=>{vi.mocked(f.runtime.deviceCustodyCurrent).mockReturnValue(false);});await expect(f.reg.register({signal:f.signal})).rejects.toThrow("fenced");expect(f.fetch).not.toHaveBeenCalled();expect(f.session.isCurrent()).toBe(true);expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
  it.each([{challenge:"11".repeat(31),expires_at:NOW+60_000},{challenge:"11".repeat(32),expires_at:NOW},{challenge:"11".repeat(32),expires_at:NOW+17*60_000}])("refuses bad challenge shape/expiry without native proof",async issued=>{
    const f=fixture();f.fetch.mockImplementationOnce(async()=>new Response(JSON.stringify(issued)));await expect(f.reg.register({signal:f.signal})).rejects.toThrow("response");expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
  it("refuses a foreign registration response",async()=>{
    const f=fixture();f.fetch.mockImplementationOnce(async()=>new Response(JSON.stringify({challenge:"11".repeat(32),expires_at:NOW+60_000}))).mockImplementationOnce(async()=>new Response(JSON.stringify({device_id:"77777777-7777-7777-7777-777777777777"})));await expect(f.reg.register({signal:f.signal})).rejects.toThrow("response");expect(f.persistence.registered).not.toHaveBeenCalled();expect(f.runtime.acknowledgeDeviceRegistration).not.toHaveBeenCalled();
  });
  it("bounds response streams and refuses HTTP failures without exposing credentials/details",async()=>{
    const f=fixture();f.fetch.mockImplementationOnce(async()=>new Response("credential and SQL detail",{status:500}));await expect(f.reg.register({signal:f.signal})).rejects.toThrow("unavailable");expect(f.runtime.signCpEnrol).not.toHaveBeenCalled();
    const g=fixture();g.fetch.mockImplementationOnce(async()=>new Response(" ".repeat(32*1024+1)));await expect(g.reg.register({signal:g.signal})).rejects.toThrow("response");expect(g.runtime.signCpEnrol).not.toHaveBeenCalled();
  });
  it("cannot register another native lifetime's custody or non-first-party kind",()=>{
    const f=fixture();vi.mocked(f.runtime.deviceCustodyCurrent).mockReturnValue(false);expect(()=>new AppCpDeviceRegistration(f.runtime,f.session,f.owned,f.persistence)).toThrow("binding");expect(f.fetch).not.toHaveBeenCalled();
    const g=fixture();Object.assign(g.session,{kind:"desktop"});expect(()=>new AppCpDeviceRegistration(g.runtime,g.session,g.owned,g.persistence)).toThrow("binding");
  });
  it("abort before network preserves custody and retires the native owner",async()=>{
    const f=fixture(),ctrl=new AbortController();ctrl.abort();await expect(f.reg.register({signal:ctrl.signal})).rejects.toThrow("fenced");expect(f.fetch).not.toHaveBeenCalled();expect(f.runtime.retireLog).toHaveBeenCalledTimes(1);
  });
});
