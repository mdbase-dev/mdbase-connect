import { describe, expect, it, vi } from "vitest";
import { AppWebDeviceKeyCustody, type AppDeviceKeyProtectedStore } from "../src/app-host/device-key-custody.js";
import type { AppDeviceBootstrap } from "../src/app-host/wasm-runtime.js";
const key = (extractable=false, length=256) => crypto.subtle.generateKey({name:"AES-GCM",length},extractable,["encrypt","decrypt"]);
async function fixture() {
  let current=true, owned=true;
  const pin={accountId:"11111111-1111-1111-1111-111111111111",connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:"88888888-8888-8888-8888-888888888888",isCurrent:()=>current,installationOwned:()=>owned};
  const data=new Map<string,Uint8Array>();
  const read=vi.fn(async(namespace:string)=>data.get(namespace)??null);
  const create=vi.fn(async(namespace:string,value:Uint8Array)=>{if(data.has(namespace))return false;data.set(namespace,new Uint8Array(value));return true;});
  const store:AppDeviceKeyProtectedStore={read,create},k=await key(),vault=new AppWebDeviceKeyCustody(pin,k,store);
  const signal=new AbortController().signal;
  const loans:AppDeviceBootstrap[]=[];const secrets:Uint8Array[]=[];
  const openDeviceConsuming=vi.fn((c:AppDeviceBootstrap)=>{loans.push(c);secrets.push(new Uint8Array([...c.signSecretKey,...c.kemSecretKey]));c.signSecretKey.fill(0);c.kemSecretKey.fill(0);return {signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3),envelope:Uint8Array.of(4,5,6)};});
  const runtime={openDeviceConsuming,retireLog:vi.fn()};
  return {pin,data,store,read,create,k,vault,signal,runtime,loans,secrets,end:()=>{secrets.forEach(b=>b.fill(0));},current:(v:boolean)=>{current=v;},owned:(v:boolean)=>{owned=v;}};
}
const fresh=(signal:AbortSignal)=>({signal,mode:"fresh" as const,noise:{mode:"fresh" as const}});
const existing=(signal:AbortSignal)=>({signal,mode:"existing" as const,noise:{mode:"existing" as const,envelope:Uint8Array.of(4,5,6)}});
describe("actual AES-GCM original device keys (memory IO/native stand-in, not platform qualification)",()=>{
  it("persists only ciphertext before one native loan, wipes JS views, restores SAME original keys",async()=>{
    const f=await fixture();try {
      const result=await f.vault.openNativeDevice(f.runtime,fresh(f.signal));expect(result.envelope).toEqual(Uint8Array.of(4,5,6));
      expect(f.create.mock.invocationCallOrder[0]!<f.runtime.openDeviceConsuming.mock.invocationCallOrder[0]!).toBe(true);
      expect(f.loans[0]!.signSecretKey.every(v=>v===0)&&f.loans[0]!.kemSecretKey.every(v=>v===0)).toBe(true);
      expect(f.secrets[0]!.some(v=>v!==0)).toBe(true);expect(f.k.extractable).toBe(false);
      expect(f.data.size).toBe(1);expect([...f.data.values()][0]!.length).toBeLessThan(256);
      const next=new AppWebDeviceKeyCustody(f.pin,f.k,f.store);await next.openNativeDevice(f.runtime,existing(f.signal));
      expect(f.secrets[0]!.every((v,i)=>v===f.secrets[1]![i])).toBe(true);
      expect(f.create).toHaveBeenCalledTimes(1);expect(f.loans[1]!.signSecretKey.every(v=>v===0)&&f.loans[1]!.kemSecretKey.every(v=>v===0)).toBe(true);
      await expect(next.openNativeDevice(f.runtime,existing(f.signal))).rejects.toThrow("preserve storage");expect(f.runtime.openDeviceConsuming).toHaveBeenCalledTimes(2);
    } finally {f.end();}
  });
  it("missing existing, existing fresh, or mixed Noise lifecycle never regenerate/overwrite",async()=>{
    const f=await fixture();await expect(f.vault.openNativeDevice(f.runtime,existing(f.signal))).rejects.toThrow("preserve");expect(f.create).not.toHaveBeenCalled();expect(f.runtime.openDeviceConsuming).not.toHaveBeenCalled();
    const g=await fixture();try {await g.vault.openNativeDevice(g.runtime,fresh(g.signal));const saved=new Uint8Array([...g.data.values()][0]!);await expect(new AppWebDeviceKeyCustody(g.pin,g.k,g.store).openNativeDevice(g.runtime,fresh(g.signal))).rejects.toThrow("preserve");expect([...g.data.values()][0]).toEqual(saved);expect(g.create).toHaveBeenCalledTimes(1);
      await expect(new AppWebDeviceKeyCustody(g.pin,g.k,g.store).openNativeDevice(g.runtime,{signal:g.signal,mode:"existing",noise:{mode:"fresh"}})).rejects.toThrow("preserve");expect(g.runtime.openDeviceConsuming).toHaveBeenCalledTimes(1);
    } finally {g.end();}
  });
  it("CAS conflict/lost applied reply preserves storage and does not open native or retry",async()=>{
    for(const lost of [false,true]) {const f=await fixture();f.create.mockImplementationOnce(async(namespace,value)=>{if(lost){f.data.set(namespace,new Uint8Array(value));throw Error("private storage detail");}return false;});
      await expect(f.vault.openNativeDevice(f.runtime,fresh(f.signal))).rejects.toThrow("app device key custody unavailable; preserve storage and reopen");expect(f.create).toHaveBeenCalledTimes(1);expect(f.runtime.openDeviceConsuming).not.toHaveBeenCalled();expect(f.data.size).toBe(lost?1:0);
      await expect(f.vault.openNativeDevice(f.runtime,fresh(f.signal))).rejects.toThrow("preserve");expect(f.create).toHaveBeenCalledTimes(1);
    }
  });
  it.each(["accountId","connectorId","deviceId","installationId"] as const)("foreign AAD %s refuses before native and preserves ciphertext",async field=>{
    const f=await fixture();try {await f.vault.openNativeDevice(f.runtime,fresh(f.signal));const saved=new Uint8Array([...f.data.values()][0]!);
      const pin={...f.pin,[field]:"99999999-9999-9999-9999-999999999999"},store={...f.store,read:async()=>saved};
      await expect(new AppWebDeviceKeyCustody(pin,f.k,store).openNativeDevice(f.runtime,existing(f.signal))).rejects.toThrow("preserve");expect(f.runtime.openDeviceConsuming).toHaveBeenCalledTimes(1);expect(f.create).toHaveBeenCalledTimes(1);
    } finally {f.end();}
  });
  it("wrong KEK/corruption/trailing/oversize never become fresh, replace identity or reach native",async()=>{
    const f=await fixture();try {await f.vault.openNativeDevice(f.runtime,fresh(f.signal));const [ns,record]=[...f.data.entries()][0]!;
      await expect(new AppWebDeviceKeyCustody(f.pin,await key(),f.store).openNativeDevice(f.runtime,existing(f.signal))).rejects.toThrow("preserve");
      for(const kind of ["tamper","trailing","oversize"]) {const changed=kind==="oversize"?new Uint8Array(257):kind==="trailing"?Uint8Array.from([...record,0]):new Uint8Array(record);if(kind==="tamper")changed[changed.length-1]=changed[changed.length-1]!^1;f.data.set(ns,changed);await expect(new AppWebDeviceKeyCustody(f.pin,f.k,f.store).openNativeDevice(f.runtime,existing(f.signal))).rejects.toThrow("preserve");expect(f.data.get(ns)).toEqual(changed);}
      expect(f.create).toHaveBeenCalledTimes(1);expect(f.runtime.openDeviceConsuming).toHaveBeenCalledTimes(1);
    } finally {f.end();}
  });
  it("requires nonextractable AES256-GCM and actual owned installation callback before any storage",async()=>{
    const f=await fixture();expect(()=>new AppWebDeviceKeyCustody(f.pin,undefined as never,f.store)).toThrow("preserve");expect(()=>new AppWebDeviceKeyCustody(f.pin,{} as never,f.store)).toThrow("preserve");
    for(const k of [await key(true),await key(false,128)]) expect(()=>new AppWebDeviceKeyCustody(f.pin,k,f.store)).toThrow("preserve");
    f.owned(false);expect(()=>new AppWebDeviceKeyCustody(f.pin,f.k,f.store)).toThrow("preserve");expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["abort","owner","current","scope","callback"])("fences %s after storage await, before RNG/unwrap/native",async reason=>{
    const f=await fixture(),ctrl=new AbortController();f.read.mockImplementationOnce(async()=>{if(reason==="abort")ctrl.abort();if(reason==="owner")f.owned(false);if(reason==="current")f.current(false);if(reason==="scope")f.pin.accountId="99999999-9999-9999-9999-999999999999";if(reason==="callback")f.pin.isCurrent=()=>true;return null;});
    await expect(f.vault.openNativeDevice(f.runtime,fresh(ctrl.signal))).rejects.toThrow("preserve");expect(f.create).not.toHaveBeenCalled();expect(f.runtime.openDeviceConsuming).not.toHaveBeenCalled();
  });
  it("abort after committed create never reaches native; native trap retires and wipes borrowed loans",async()=>{
    const f=await fixture(),ctrl=new AbortController();f.create.mockImplementationOnce(async(ns,bytes)=>{f.data.set(ns,new Uint8Array(bytes));ctrl.abort();return true;});await expect(f.vault.openNativeDevice(f.runtime,fresh(ctrl.signal))).rejects.toThrow("preserve");expect(f.runtime.openDeviceConsuming).not.toHaveBeenCalled();expect(f.data.size).toBe(1);
    const g=await fixture();g.runtime.openDeviceConsuming.mockImplementationOnce(c=>{g.loans.push(c);throw Error("private native detail");});await expect(g.vault.openNativeDevice(g.runtime,fresh(g.signal))).rejects.toThrow("preserve");expect(g.loans[0]!.signSecretKey.every(v=>v===0)&&g.loans[0]!.kemSecretKey.every(v=>v===0)).toBe(true);expect(g.runtime.retireLog).toHaveBeenCalledTimes(1);expect(g.data.size).toBe(1);
  });
});
