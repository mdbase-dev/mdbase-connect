import { describe,expect,it,vi } from "vitest";
import { AppWebNoiseCustody,type AppNoiseProtectedStore } from "../src/app-host/noise-custody.js";
import type { AppDeviceRegistrationReceipt } from "../src/app-host/wasm-runtime.js";
const key=async(extractable=false,length=256)=>await globalThis.crypto.subtle.generateKey({name:"AES-GCM",length},extractable,["encrypt","decrypt"]);
async function fixture() {
  const pin={connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:"88888888-8888-8888-8888-888888888888",isCurrent:()=>true};
  const data=new Map<string,Uint8Array>();const read=vi.fn(async(namespace:string)=>data.get(namespace)??null);
  const compareAndSet=vi.fn(async(namespace:string,expected:Uint8Array|null,encrypted:Uint8Array)=>{const actual=data.get(namespace)??null;if(actual===null?expected!==null:expected===null || actual.length!==expected.length || actual.some((b,i)=>b!==expected[i]))return false;data.set(namespace,new Uint8Array(encrypted));return true;});
  const store:AppNoiseProtectedStore={read,compareAndSet},k=await key(),vault=new AppWebNoiseCustody(pin,k,store),signal=new AbortController().signal;
  const receipt:AppDeviceRegistrationReceipt={connectorId:pin.connectorId,deviceId:pin.deviceId,installationId:pin.installationId,signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3)};return {pin,data,read,compareAndSet,store,k,vault,signal,receipt};
}
describe("actual WebCrypto outer Noise custody (memory IO fixture, not platform qualification)",()=>{
  it("outer-wraps ONLY native ciphertext with non-extractable AES KEK and preserves borrowed buffers",async()=>{
    const f=await fixture(),envelope=Buffer.from([4,5,6]);expect(f.k.extractable).toBe(false);expect(await f.vault.restore({signal:f.signal})).toBeNull();await f.vault.pending(envelope,{signal:f.signal});expect([...envelope]).toEqual([4,5,6]);
    const stored=new Uint8Array([...f.data.values()][0]!);expect(stored).not.toEqual(envelope);expect(await f.vault.restore({signal:f.signal})).toEqual({envelope:Uint8Array.of(4,5,6),receipt:null,privateEnrolMarker:null});await f.vault.registered(f.receipt,{signal:f.signal});
    const restored=await f.vault.restore({signal:f.signal});expect(restored!.envelope).toEqual(new Uint8Array(envelope));expect(restored!.receipt).toMatchObject({connectorId:f.pin.connectorId,deviceId:f.pin.deviceId,noisePublicKey:new Uint8Array(32).fill(3)});expect([...f.data.values()][0]!.some(b=>b!==0)).toBe(true);
  });
  it("pending writes NEVER erase complete receipt or replace existing Noise identity",async()=>{
    const f=await fixture();await f.vault.pending(Uint8Array.of(4,5,6),{signal:f.signal});await f.vault.registered(f.receipt,{signal:f.signal});const before=new Uint8Array([...f.data.values()][0]!);await f.vault.pending(Uint8Array.of(4,5,6),{signal:f.signal});await expect(f.vault.pending(Uint8Array.of(7,8),{signal:f.signal})).rejects.toThrow("preserve");expect([...f.data.values()][0]).toEqual(before);expect(f.compareAndSet).toHaveBeenCalledTimes(2);
  });
  it("corrupt ciphertext, missing/wrong KEK, wrong scope, version/trailing refuse without fallback/deletion",async()=>{
    const f=await fixture();await f.vault.pending(Uint8Array.of(4,5),{signal:f.signal});const [namespace,original]=[...f.data.entries()][0]!;
    const wrong=new AppWebNoiseCustody(f.pin,await key(),f.store);await expect(wrong.restore({signal:f.signal})).rejects.toThrow("preserve");
    const scope={...f.pin,installationId:"99999999-9999-9999-9999-999999999999"};const replay=new AppWebNoiseCustody(scope,f.k,{...f.store,read:async()=>original});await expect(replay.restore({signal:f.signal})).rejects.toThrow("preserve");
    for(const kind of ["tamper","trailing","oversize"]){const changed=kind==="oversize"?new Uint8Array(4097):kind==="trailing"?Uint8Array.from([...original,0]):new Uint8Array(original);if(kind==="tamper")changed[changed.length-1]=changed[changed.length-1]!^1;f.data.set(namespace,changed);await expect(f.vault.restore({signal:f.signal})).rejects.toThrow("preserve");expect(f.data.get(namespace)).toEqual(changed);}
    expect(f.compareAndSet).toHaveBeenCalledTimes(1);
  });
  it("rejects extractable/wrong-purpose/wrong-sized KEK and nil scopes before storage",async()=>{
    const f=await fixture();expect(()=>new AppWebNoiseCustody(f.pin,undefined as never,f.store)).toThrow();
    const extractable=await key(true);expect(()=>new AppWebNoiseCustody(f.pin,extractable,f.store)).toThrow("preserve");const small=await key(false,128);expect(()=>new AppWebNoiseCustody(f.pin,small,f.store)).toThrow("preserve");expect(()=>new AppWebNoiseCustody({...f.pin,deviceId:"00000000-0000-0000-0000-000000000000"},f.k,f.store)).toThrow("preserve");expect(f.read).not.toHaveBeenCalled();
  });
  it("CAS conflict and uncertain applied write never trigger retries or erasure",async()=>{
    const f=await fixture();f.compareAndSet.mockResolvedValueOnce(false);await expect(f.vault.pending(Uint8Array.of(4,5),{signal:f.signal})).rejects.toThrow("preserve");expect(f.compareAndSet).toHaveBeenCalledTimes(1);expect(f.data.size).toBe(0);
    const g=await fixture();g.compareAndSet.mockImplementationOnce(async(namespace,_expected,encrypted)=>{g.data.set(namespace,new Uint8Array(encrypted));throw new Error("private platform detail");});await expect(g.vault.pending(Uint8Array.of(4,5),{signal:g.signal})).rejects.toThrow("preserve");expect(g.compareAndSet).toHaveBeenCalledTimes(1);expect(await g.vault.restore({signal:g.signal})).toEqual({envelope:Uint8Array.of(4,5),receipt:null,privateEnrolMarker:null});
  });
  it("requires protected pending record and exact registered receipt scope before completion",async()=>{
    const f=await fixture();await expect(f.vault.registered(f.receipt,{signal:f.signal})).rejects.toThrow("preserve");await f.vault.pending(Uint8Array.of(4,5),{signal:f.signal});await expect(f.vault.registered({...f.receipt,connectorId:"77777777-7777-7777-7777-777777777777"},{signal:f.signal})).rejects.toThrow("preserve");expect(f.compareAndSet).toHaveBeenCalledTimes(1);expect((await f.vault.restore({signal:f.signal}))!.receipt).toBeNull();
  });
  it("protects PUBLIC exact enrol tuple/commit, reopens idempotently and never clears an acknowledged marker",async()=>{
    const f=await fixture(),options={signal:f.signal};await f.vault.pending(Uint8Array.of(4,5),options);await f.vault.registered(f.receipt,options);
    const marker={...f.receipt,collection:"22222222-2222-2222-2222-222222222222",sasCommitment:Buffer.alloc(32,11),acknowledged:false};
    await f.vault.privateEnrolPending(marker,options);expect(marker.sasCommitment.every(b=>b===11)).toBe(true);
    const reopened=new AppWebNoiseCustody(f.pin,f.k,f.store),restored=(await reopened.restore(options))!.privateEnrolMarker!;
    expect(restored).toEqual({...marker,sasCommitment:new Uint8Array(marker.sasCommitment)});const saved=new Uint8Array([...f.data.values()][0]!);await reopened.privateEnrolPending(restored,options);expect([...f.data.values()][0]).toEqual(saved);
    for(const changed of [{sasCommitment:new Uint8Array(32).fill(12)},{collection:"33333333-3333-3333-3333-333333333333"},{noisePublicKey:new Uint8Array(32).fill(12)},{connectorId:"77777777-7777-7777-7777-777777777777"}]) {await expect(reopened.privateEnrolPending({...restored,...changed},options)).rejects.toThrow("preserve");expect([...f.data.values()][0]).toEqual(saved);}
    await reopened.privateEnrolAcknowledged(restored,options);const acknowledged=(await reopened.restore(options))!.privateEnrolMarker!;expect(acknowledged).toMatchObject({acknowledged:true,sasCommitment:restored.sasCommitment});
    const completed=new Uint8Array([...f.data.values()][0]!);await expect(reopened.privateEnrolPending(restored,options)).rejects.toThrow("preserve");await reopened.privateEnrolAcknowledged(acknowledged,options);await reopened.registered(f.receipt,options);await reopened.pending(Uint8Array.of(4,5),options);expect([...f.data.values()][0]).toEqual(completed);
  });
  it("requires actual registration before public marker and preserves an uncertain applied marker write",async()=>{
    const f=await fixture(),options={signal:f.signal},marker={...f.receipt,collection:"22222222-2222-2222-2222-222222222222",sasCommitment:new Uint8Array(32).fill(11),acknowledged:false};
    await expect(f.vault.privateEnrolPending(marker,options)).rejects.toThrow("preserve");await f.vault.pending(Uint8Array.of(4,5),options);await expect(f.vault.privateEnrolPending(marker,options)).rejects.toThrow("preserve");await f.vault.registered(f.receipt,options);
    await expect(f.vault.privateEnrolAcknowledged(marker,options)).rejects.toThrow("preserve");
    f.compareAndSet.mockImplementationOnce(async(namespace,_expected,encrypted)=>{f.data.set(namespace,new Uint8Array(encrypted));throw Error("private diagnostic");});
    await expect(f.vault.privateEnrolPending(marker,options)).rejects.toThrow("preserve");expect((await f.vault.restore(options))!.privateEnrolMarker).toEqual(marker);
    const before=new Uint8Array([...f.data.values()][0]!);await f.vault.privateEnrolPending(marker,options);expect([...f.data.values()][0]).toEqual(before);expect(f.compareAndSet).toHaveBeenCalledTimes(3);
  });
  it("fences source mutation/abort after storage awaits",async()=>{
    const f=await fixture();f.read.mockImplementationOnce(async()=>{f.pin.isCurrent=()=>false;return null;});await expect(f.vault.restore({signal:f.signal})).rejects.toThrow("preserve");expect(f.compareAndSet).not.toHaveBeenCalled();
    const g=await fixture(),ctrl=new AbortController();ctrl.abort();await expect(g.vault.pending(Uint8Array.of(4,5),{signal:ctrl.signal})).rejects.toThrow("preserve");expect(g.read).not.toHaveBeenCalled();
  });
});
