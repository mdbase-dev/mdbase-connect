import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AppWasmRuntime, type AppBootstrap, type AppSqlLifetime } from "../src/app-host/wasm-runtime.js";
import * as cbor from "../src/cbor.js";
import { syncStatus } from "../src/wire.js";

const COLLECTION = "0192f3a4-6000-7abc-8def-0123456789ab";
const basesFixture = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-codec.json", import.meta.url), "utf8")) as {request_hex: string; success_hex: string};
const config = (): AppBootstrap => ({ collection: COLLECTION, replicaId: "0192f3a4-6000-7abc-8def-0123456789ac", deviceId: "0192f3a4-6000-7abc-8def-0123456789ad", endpoint: 37, trustedRoots: [new Uint8Array(32).fill(9)], policyPins: cbor.encode([[[new Uint8Array(16).fill(1), new Uint8Array(32).fill(9)]], [[new Uint8Array(16).fill(2), new Uint8Array(32).fill(10), new Uint8Array(16).fill(1)]]]), trustedSigners: [], expectedGenesis: `sha256:${"08".repeat(32)}`, state: "e2e", cloudCopyOptIn: false, signSecretKey: new Uint8Array(32).fill(4), kemSecretKey: new Uint8Array(32).fill(5), opened: "existing", sqliteVersion: 3_050_004 });
afterEach(() => vi.restoreAllMocks());
async function fixture(outcome: "success" | "refused" | "trap" | "allocation" | "legacy" = "success") {
  const memory = new WebAssembly.Memory({ initial: 4 }); let next = 1024,generation=1n;
  const alloc = (len: number) => { const p = next; next += len + 16; return p; };
  const pack = (bytes: Uint8Array) => { const p = alloc(bytes.length); new Uint8Array(memory.buffer, p, bytes.length).set(bytes); return (BigInt(p) << 32n) | BigInt(bytes.length); };
  let pins: Map<cbor.CborValue, cbor.CborValue> | null = null;
  const observations = new Map<number, cbor.CborValue>([[0, syncStatus.enc({ mode: "synced", confirmedThrough: 0, headKnown: 0, pending: 0, holds: 0, unresolved: 0, connection: "offline", incidents: [] })], [1, false], [2, false], [3, true], [4, false]]);
  const bind = vi.fn(() => 1), retire = vi.fn(), shutdown = vi.fn(() => 1), reply = vi.fn(() => 0);
  const x = { memory, alloc: (len: number) => { if (outcome === "allocation") throw new Error("secret allocator detail"); return alloc(len); }, dealloc: vi.fn(), rt_info: () => 0n, rt_open: vi.fn(), rt_hello: () => pack(cbor.encode([8, cbor.encode(new Map())])), rt_frame: vi.fn(), rt_close: vi.fn(), rt_tick: vi.fn(), rt_poll: () => pack(cbor.encode([])),
    rt_app_open: (p: number, n: number) => {
      if (outcome === "trap") throw new WebAssembly.RuntimeError("secret trap detail");
      pins = cbor.decode(new Uint8Array(memory.buffer, p, n)) as Map<cbor.CborValue, cbor.CborValue>;
      new Uint8Array(memory.buffer, p, n).fill(0);
      return outcome === "refused" ? pack(new TextEncoder().encode("secret SQL detail")) : 0n;
    },
    rt_app_device_open: vi.fn((p: number,n: number)=>{pins=cbor.decode(new Uint8Array(memory.buffer,p,n)) as Map<cbor.CborValue,cbor.CborValue>;new Uint8Array(memory.buffer,p,n).fill(0);return pack(cbor.encode(new Map<number,cbor.CborValue>([[0,new Uint8Array(32).fill(1)],[1,new Uint8Array(32).fill(2)],[2,new Uint8Array(32).fill(3)],[3,Uint8Array.of(4,5,6)]])));}),
    rt_app_cloud_copy_pin:vi.fn((p:number,n:number)=>{pins=cbor.decode(new Uint8Array(memory.buffer,p,n)) as Map<cbor.CborValue,cbor.CborValue>;new Uint8Array(memory.buffer,p,n).fill(0);return 1;}),
    rt_app_cloud_copy_create_sign:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(new Uint8Array(64).fill(14));}),
    rt_app_cloud_copy_join_sign:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(new Uint8Array(64).fill(15));}),
    rt_app_private_collection_pin:vi.fn((p:number,n:number)=>{pins=cbor.decode(new Uint8Array(memory.buffer,p,n)) as Map<cbor.CborValue,cbor.CborValue>;new Uint8Array(memory.buffer,p,n).fill(0);return 1;}),
    rt_app_private_enrol_restore:vi.fn((p:number,n:number)=>{pins=cbor.decode(new Uint8Array(memory.buffer,p,n)) as Map<cbor.CborValue,cbor.CborValue>;new Uint8Array(memory.buffer,p,n).fill(0);return 1;}),
    rt_app_private_enrol_commitment:vi.fn(()=>pack(new Uint8Array(32).fill(11))),
    rt_app_private_create_sign:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(new Uint8Array(64).fill(12));}),
    rt_app_private_device_enrol_sign:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(new Uint8Array(64).fill(13));}),
    rt_app_account_key_unlock:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(cbor.encode(new Map<number,cbor.CborValue>([[0,0],[1,null]])));}),
    rt_app_account_key_device_setup:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(cbor.encode(new Map<number,cbor.CborValue>([[0,0],[1,null]])));}),
    rt_app_account_key_status:vi.fn(()=>pack(cbor.encode(new Map<number,cbor.CborValue>([[0,0],[1,null]])))),
    rt_app_device_registered:vi.fn((p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return 1;}),
    rt_app_device_adopt:vi.fn((p:number,n:number)=>{pins=cbor.decode(new Uint8Array(memory.buffer,p,n)) as Map<cbor.CborValue,cbor.CborValue>;new Uint8Array(memory.buffer,p,n).fill(0);return 0n;}),
    rt_app_device_retire:vi.fn(),
    rt_app_cp_enrol_sign: vi.fn((p: number,n: number) => { new Uint8Array(memory.buffer,p,n).fill(0); return pack(cbor.encode(new Map<number,cbor.CborValue>([[0,new Uint8Array(32).fill(1)],[1,new Uint8Array(32).fill(2)],[2,new Uint8Array(32).fill(3)],[3,new Uint8Array(64).fill(7)]]))); }),
    rt_app_bases_execute: vi.fn((_session: bigint, p: number, n: number) => { new Uint8Array(memory.buffer,p,n).fill(0); return pack(cbor.fromHex(basesFixture.success_hex)); }),
    rt_app_bases_list_views: vi.fn((_session:bigint,p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(Uint8Array.of(1));}),
    rt_app_bases_read_view_source: vi.fn((_session:bigint,p:number,n:number)=>{new Uint8Array(memory.buffer,p,n).fill(0);return pack(Uint8Array.of(2));}),
    rt_app_verify_handover: vi.fn((_s: bigint, _dp: number, _dn: number, _wp: number, _wn: number) => pack(cbor.encode(new Map<number, cbor.CborValue>([[0, 1], [1, new Uint8Array(32).fill(1)], [2, new Uint8Array(32).fill(2)], [3, new Uint8Array(32).fill(3)]])))),
    rt_app_cp_bind_connector: vi.fn(() => 1), rt_app_cp_log_token_sign: vi.fn((p: number, n: number) => { new Uint8Array(memory.buffer, p, n).fill(0); return pack(new Uint8Array(64).fill(8)); }),
    rt_app_log_reconnect:vi.fn(()=>{generation++;return 1;}),rt_app_log_generation: () => generation, rt_app_log_http_sign: vi.fn((_endpoint: bigint, _generation: bigint, _original: bigint, p: number, n: number) => { new Uint8Array(memory.buffer, p, n).fill(0); return pack(new Uint8Array(64).fill(7)); }),
    rt_app_log_bind: bind, rt_app_log_calls: () => pack(cbor.encode([])), rt_app_log_reply: reply, rt_app_log_no_response: vi.fn(), rt_app_log_retire: retire, rt_app_log_push: vi.fn(() => 0), rt_app_observations: () => pack(cbor.encode(observations)), rt_app_shutdown: shutdown,
  };
  if (outcome === "legacy") delete (x as Partial<typeof x>).rt_app_open;
  let imports: WebAssembly.Imports | undefined;
  vi.spyOn(WebAssembly, "instantiate").mockImplementation(async (_bytes, env) => { imports = env; return { instance: { exports: x } } as unknown as WebAssembly.Instance; });
  const original = cbor.encodeSecret; let encoded: Uint8Array | null = null;
  vi.spyOn(cbor, "encodeSecret").mockImplementation(v => { encoded = original(v); return encoded; });
  const sql: AppSqlLifetime = { import: vi.fn(() => () => 0n), fence: vi.fn(), needsRecovery: false };
  return { create: () => AppWasmRuntime.create(new Uint8Array(), sql), createDevice:()=>AppWasmRuntime.createDevice(new Uint8Array()), sql, pins: () => pins!, encoded: () => encoded!, imports: () => imports!, x, bind, retire, reply, shutdown, observations };
}
describe("optional app artifact host", () => {
  it.each(["list-views","read-view-source"] as const)("discovery %s uses only current actual held native session, not generic frame/execute",async operation=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const port=rt.connect(),request=Uint8Array.of(7);
    expect(()=>rt.discoverBases(port,operation,request)).toThrow();port.send(new Map());await Promise.resolve();
    expect(rt.discoverBases(port,operation,request)).toEqual(Uint8Array.of(operation==="list-views"?1:2));
    const calls=operation==="list-views"?f.x.rt_app_bases_list_views:f.x.rt_app_bases_read_view_source;expect(calls.mock.calls[0]?.[0]).toBe(8n);
    expect(request).toEqual(Uint8Array.of(7));expect(f.x.rt_app_bases_execute).not.toHaveBeenCalled();
    expect(()=>rt.discoverBases({...port},operation,request)).toThrow();expect(()=>rt.discoverBases(port,"unknown" as "list-views",request)).toThrow();
    port.close();expect(()=>rt.discoverBases(port,operation,request)).toThrow();await rt.close();
  });
  it("missing discovery export refuses without runtime fencing/generic fallback",async()=>{
    const f=await fixture();delete(f.x as Partial<typeof f.x>).rt_app_bases_list_views;const rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();
    expect(()=>rt.discoverBases(port,"list-views",Uint8Array.of(1))).toThrow();expect(f.x.rt_app_bases_execute).not.toHaveBeenCalled();expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it.each(["trap","oversize"] as const)("native discovery %s fences before output copy",async mode=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();const dealloc=f.x.dealloc.mock.calls.length;
    if(mode==="trap")f.x.rt_app_bases_list_views.mockImplementationOnce(()=>{throw new WebAssembly.RuntimeError("private detail");});else f.x.rt_app_bases_list_views.mockReturnValueOnce(BigInt(1024*1024+1));
    expect(()=>rt.discoverBases(port,"list-views",Uint8Array.of(1))).toThrow();expect(f.sql.fence).toHaveBeenCalledOnce();expect(f.x.dealloc.mock.calls.length).toBe(dealloc);await rt.close();
  });
  it("native discovery original session lost during ABI suppresses output",async()=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();const original=f.x.rt_app_bases_list_views.getMockImplementation()!;
    f.x.rt_app_bases_list_views.mockImplementationOnce((s,p,n)=>{port.close();return original(s,p,n);});expect(()=>rt.discoverBases(port,"list-views",Uint8Array.of(1))).toThrow();await rt.close();
  });
  it("Bases binding uses only the actual current held session; raw ABI mock is not native execution proof", async () => {
    const f=await fixture(), rt=await f.create();rt.openAppConsuming(config());const port=rt.connect(),borrowed=cbor.fromHex(basesFixture.request_hex);
    expect(()=>rt.executeBases(port,borrowed)).toThrow();expect(f.x.rt_app_bases_execute).not.toHaveBeenCalled();
    port.send(new Map());await Promise.resolve();
    expect(rt.executeBases(port,borrowed)).toEqual(cbor.fromHex(basesFixture.success_hex));expect(f.x.rt_app_bases_execute.mock.calls[0]?.[0]).toBe(8n);expect(borrowed).toEqual(cbor.fromHex(basesFixture.request_hex));
    expect(()=>rt.executeBases({...port},borrowed)).toThrow();expect(()=>rt.executeBases(port,new Uint8Array(128*1024+1))).toThrow();
    port.close();expect(()=>rt.executeBases(port,borrowed)).toThrow();expect(f.x.rt_app_bases_execute).toHaveBeenCalledOnce();expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it("Bases missing export refuses without generic frame fallback or startup change",async()=>{
    const f=await fixture();delete (f.x as Partial<typeof f.x>).rt_app_bases_execute;const rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();
    expect(()=>rt.executeBases(port,cbor.fromHex(basesFixture.request_hex))).toThrow();expect(f.x.rt_frame).not.toHaveBeenCalled();expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it.each(["trap","oversize"] as const)("Bases %s ABI observation fences before publication/allocation",async mode=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();const dealloc=f.x.dealloc.mock.calls.length;
    if(mode==="trap")f.x.rt_app_bases_execute.mockImplementationOnce(()=>{throw new WebAssembly.RuntimeError("private ABI detail");});else f.x.rt_app_bases_execute.mockReturnValueOnce(BigInt(16*1024*1024+1));
    expect(()=>rt.executeBases(port,cbor.fromHex(basesFixture.request_hex))).toThrow("app runtime unavailable; reopen and reconcile");expect(f.sql.fence).toHaveBeenCalledOnce();expect(f.x.dealloc.mock.calls.length).toBe(dealloc);expect(()=>rt.connect()).toThrow();await rt.close();
  });
  it("Bases session loss during native read suppresses its complete output",async()=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const port=rt.connect();port.send(new Map());await Promise.resolve();const original=f.x.rt_app_bases_execute.getMockImplementation()!;
    f.x.rt_app_bases_execute.mockImplementationOnce((s,p,n)=>{port.close();return original(s,p,n);});expect(()=>rt.executeBases(port,cbor.fromHex(basesFixture.request_hex))).toThrow();expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it.each([undefined, new Uint8Array(), new Uint8Array(65_537)])("mandatory bundled pins refuse without an unpinned fallback (%s)", async pins => {
    const f=await fixture(),rt=await f.create(),c=config();
    c.policyPins=pins as Uint8Array;
    expect(()=>rt.openAppConsuming(c)).toThrow("app runtime unavailable");
    expect(c.signSecretKey.every(b=>b===0)).toBe(true);expect(c.kemSecretKey.every(b=>b===0)).toBe(true);
    expect(f.pins()).toBeNull();await rt.close();
    const d=await fixture(),device=await d.createDevice(),dc=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:dc.deviceId,isCurrent:()=>true};
    const custody=device.openDeviceConsuming({pin,signSecretKey:dc.signSecretKey,kemSecretKey:dc.kemSecretKey,opened:{mode:"fresh"}});device.acknowledgeDeviceRegistration({...pin,...custody});
    dc.policyPins=pins as Uint8Array;expect(()=>device.adoptDevice(dc,d.sql)).toThrow("app runtime unavailable");
    expect(d.sql.import).not.toHaveBeenCalled();expect(d.x.rt_app_device_adopt).not.toHaveBeenCalled();await device.close();
  });
  it("local facade cannot bind a foreign collection or loan host controls", async () => {
    const f = await fixture(), rt = await f.create();
    rt.openAppConsuming(config());
    expect(() => rt.connect({ collection: "44444444-4444-4444-8444-444444444444" })).toThrow("app runtime unavailable");
    expect(() => rt.connect({ collection: 37 as unknown as string })).toThrow("app runtime unavailable");
    expect(f.sql.fence).not.toHaveBeenCalled();
    const port = rt.connect({ collection: COLLECTION.toUpperCase() });
    port.close();
    await rt.close();
  });
  it.each(["create","join"] as const)("cloud-copy %s binds original native purpose once, no private/SAS/SQL",async purpose=>{
    const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});rt.acknowledgeDeviceRegistration({...pin,...custody});const target={...pin,collection:c.collection,purpose,approvalMode:"password-ak1" as const};rt.prepareCloudCopyCollection(target);expect(f.pins().get(1)).toBe(purpose==="create"?0:1);const nonce=new Uint8Array(32).fill(9);expect(purpose==="create"?rt.signCloudCopyCreate(nonce):rt.signCloudCopyJoin(nonce)).toHaveLength(64);expect(nonce.every(v=>v===9)).toBe(true);expect(f.sql.import).not.toHaveBeenCalled();expect(f.x.rt_app_private_collection_pin).not.toHaveBeenCalled();expect(f.x.rt_app_private_enrol_commitment).not.toHaveBeenCalled();expect(()=>rt.signCloudCopyCreate(nonce)).toThrow();expect(rt.cloudCopyCollectionCurrent()).toBe(false);await rt.close();
  });
  it("cloud-copy strict approval and private adoption refuse before native/SQL",async()=>{
    for(const strict of [true,false]){const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});rt.acknowledgeDeviceRegistration({...pin,...custody});const target={...pin,collection:c.collection,purpose:"create" as const,approvalMode:strict?"strict" as const:"password-ak1" as const};if(strict){expect(()=>rt.prepareCloudCopyCollection(target)).toThrow("this account uses strict device approval; add this device from your desktop");expect(f.x.rt_app_cloud_copy_pin).not.toHaveBeenCalled();}else{rt.prepareCloudCopyCollection(target);expect(()=>rt.adoptDevice(c,f.sql)).toThrow();expect(f.x.rt_app_device_adopt).not.toHaveBeenCalled();}expect(f.sql.import).not.toHaveBeenCalled();await rt.close();}
  });
  it("registered host pins prospective collection once, fixed create domain preserves borrowed nonce",async()=>{
    const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});rt.acknowledgeDeviceRegistration({...pin,...custody});const target={...pin,collection:c.collection,purpose:"create" as const,approvalMode:"password-ak1" as const};rt.preparePrivateCollection(target,{mode:"fresh"});expect(f.pins().size).toBe(2);expect(f.x.rt_app_private_enrol_commitment).not.toHaveBeenCalled();const nonce=Buffer.alloc(32,9);expect(rt.signPrivateCreate(nonce)).toHaveLength(64);expect(nonce.every(b=>b===9)).toBe(true);expect(f.x.rt_app_private_device_enrol_sign).not.toHaveBeenCalled();expect(f.sql.import).not.toHaveBeenCalled();rt.retireLog();await rt.close();
  });
  it.each([false,true])("default enrol native commitment and strict typed refusal (%s)",async strict=>{
    {const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});rt.acknowledgeDeviceRegistration({...pin,...custody});const target={...pin,collection:c.collection,purpose:"enrol" as const,approvalMode:strict?"strict" as const:"password-ak1" as const};if(strict){try{rt.preparePrivateCollection(target,{mode:"fresh"});throw Error("accepted strict");}catch(e){expect(e).toMatchObject({reason:"strict_device_approval",message:"this account uses strict device approval; add this device from your desktop"});}expect(f.x.rt_app_private_collection_pin).not.toHaveBeenCalled();expect(f.x.rt_app_private_device_enrol_sign).not.toHaveBeenCalled();expect(rt.privateCollectionCurrent()).toBe(false);}else{rt.preparePrivateCollection(target,{mode:"fresh"});const nonce=Buffer.alloc(32,9),proof=rt.signPrivateDeviceEnrol(nonce);expect(proof.sasCommitment).toEqual(new Uint8Array(32).fill(11));proof.sasCommitment.fill(0);expect(nonce.every(b=>b===9)).toBe(true);expect(f.x.rt_app_private_create_sign).not.toHaveBeenCalled();}rt.retireLog();await rt.close();}
  });
  it.each([false,true])("protected public marker restores same commit without new SAS; acknowledged skips proof (%s)",async acknowledged=>{
    const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};
    const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"existing",envelope:Uint8Array.of(4,5,6)}});rt.acknowledgeDeviceRegistration({...pin,...custody});
    const marker={...pin,...custody,collection:c.collection,sasCommitment:Buffer.alloc(32,11),acknowledged};rt.preparePrivateCollection({...pin,collection:c.collection,purpose:"enrol",approvalMode:"password-ak1"},{mode:"existing",marker});
    expect(f.x.rt_app_private_collection_pin).not.toHaveBeenCalled();expect(f.x.rt_app_private_enrol_restore).toHaveBeenCalledTimes(1);expect(f.pins().size).toBe(10);expect(f.pins().get(8)).toEqual(new Uint8Array(32).fill(11));expect(f.pins().get(9)).toBe(acknowledged);expect(marker.sasCommitment.every(b=>b===11)).toBe(true);marker.sasCommitment.fill(0);
    expect(rt.privateEnrolMarker().sasCommitment).toEqual(new Uint8Array(32).fill(11));
    if(acknowledged) {rt.adoptDevice(c,f.sql);expect(f.x.rt_app_private_device_enrol_sign).not.toHaveBeenCalled();} else {expect(rt.signPrivateDeviceEnrol(Buffer.alloc(32,9)).sasCommitment).toEqual(new Uint8Array(32).fill(11));}
    await rt.close();
  });
  it.each(["connectorId","deviceId","installationId","collection","signPublicKey","kemPublicKey","noisePublicKey","sasCommitment"])('foreign/missing protected marker field %s refuses without fresh fallback',async field=>{
    const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"existing",envelope:Uint8Array.of(4,5,6)}});rt.acknowledgeDeviceRegistration({...pin,...custody});
    const marker={...pin,...custody,collection:c.collection,sasCommitment:new Uint8Array(32).fill(11),acknowledged:false,...{[field]:field.endsWith("Key")||field==="sasCommitment"?new Uint8Array(32):"99999999-9999-9999-9999-999999999999"}};
    expect(()=>rt.preparePrivateCollection({...pin,collection:c.collection,purpose:"enrol",approvalMode:"password-ak1"},{mode:"existing",marker})).toThrow();expect(f.x.rt_app_private_enrol_restore).not.toHaveBeenCalled();expect(f.x.rt_app_private_collection_pin).not.toHaveBeenCalled();expect(f.sql.import).not.toHaveBeenCalled();await rt.close();
  });
  it.each(["pending","foreign","strict"])("protected account R loan wipes and never infers keyed (%s)",async mode=>{
    const f=await fixture(),rt=await f.createDevice(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});rt.acknowledgeDeviceRegistration({...pin,...custody});rt.adoptDevice(c,f.sql);
    const source={...pin,collection:mode==="foreign"?"99999999-9999-9999-9999-999999999999":c.collection,approvalMode:mode==="strict"?"strict" as const:"password-ak1" as const},secret=Buffer.alloc(32,3);
    if(mode==="pending"){expect(rt.unlockAccountKeyConsuming(source,secret)).toEqual({state:"pending"});expect(rt.accountKeyStatus(source)).toEqual({state:"pending"});const setupLoan=Buffer.alloc(32,3);expect(rt.setupAccountKeyDeviceConsuming(source,setupLoan)).toEqual({state:"recovery_pending"});expect(setupLoan.every(v=>v===0)).toBe(true);expect(f.x.rt_app_account_key_unlock).toHaveBeenCalledTimes(1);}else{expect(()=>rt.unlockAccountKeyConsuming(source,secret)).toThrow();expect(f.x.rt_app_account_key_unlock).not.toHaveBeenCalled();}
    expect(secret.every(v=>v===0)).toBe(true);await rt.close();
  });
  it("device phase has no Core/LS/SQL authority and adopts SAME owners with metadata-only v4", async () => {
    const f=await fixture(),rt=await f.createDevice(),c=config();expect(f.sql.import).not.toHaveBeenCalled();expect((f.imports().env!.host_app_sql as (p:number,n:number)=>bigint)(0,0)).toBe(0n);const pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};const borrowed=Buffer.from([4,5,6]);
    const custody=rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"existing",envelope:borrowed}});expect([...borrowed]).toEqual([4,5,6]);expect(c.signSecretKey.every(b=>b===0)).toBe(true);expect(c.kemSecretKey.every(b=>b===0)).toBe(true);expect(f.pins().size).toBe(8);expect(()=>rt.connect()).toThrow();expect(()=>rt.observations()).toThrow();expect(f.bind).not.toHaveBeenCalled();expect(f.sql.fence).not.toHaveBeenCalled();
    const nonce=Buffer.alloc(32,0x11);expect(rt.signCpEnrol(nonce).signature).toHaveLength(64);expect(nonce.every(b=>b===0x11)).toBe(true);
    const receipt={...pin,...custody};rt.acknowledgeDeviceRegistration(receipt);rt.adoptDevice(c,f.sql);expect(f.sql.import).toHaveBeenCalledTimes(1);expect(f.pins().size).toBe(17);expect(f.pins().get(0)).toBe(4);expect(f.pins().get(16)).toEqual(c.policyPins);expect(f.pins().get(10)).toBeNull();expect(f.pins().get(11)).toBeNull();expect(f.encoded().every(b=>b===0)).toBe(true);expect(f.x.rt_app_device_adopt).toHaveBeenCalledTimes(1);expect(rt.observations().snapshotInstallAvailable).toBe(true);await rt.close();
  });
  it("failed existing device custody never falls back to fresh and retires without SQL wipe/fault", async () => {
    const f=await fixture(),rt=await f.create(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:config().deviceId,isCurrent:()=>true};
    f.x.rt_app_device_open.mockReturnValueOnce(0n);const c=config();expect(()=>rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"existing",envelope:Uint8Array.of(9)}})).toThrow();const second=config();expect(()=>rt.openDeviceConsuming({pin,signSecretKey:second.signSecretKey,kemSecretKey:second.kemSecretKey,opened:{mode:"fresh"}})).toThrow();expect(f.x.rt_app_device_open).toHaveBeenCalledTimes(1);expect(f.x.rt_app_device_retire).toHaveBeenCalledTimes(1);expect(f.sql.fence).not.toHaveBeenCalled();expect(second.signSecretKey.every(b=>b===0)).toBe(true);await rt.close();
  });
  it("no registration receipt/adoption or v1 fallback can arise merely from persisted ciphertext", async ()=>{
    const f=await fixture(),rt=await f.create(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"existing",envelope:Uint8Array.of(9)}});expect(()=>rt.adoptDevice(c)).toThrow();expect(f.x.rt_app_device_adopt).not.toHaveBeenCalled();expect(f.x.rt_app_device_retire).toHaveBeenCalledTimes(1);expect(()=>rt.openAppConsuming(config())).toThrow();expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it("device pin loss retires native keys, never a collection SQL reset", async ()=>{
    const f=await fixture(),rt=await f.create(),c=config(),pin={connectorId:"66666666-6666-6666-6666-666666666666",installationId:"88888888-8888-8888-8888-888888888888",deviceId:c.deviceId,isCurrent:()=>true};rt.openDeviceConsuming({pin,signSecretKey:c.signSecretKey,kemSecretKey:c.kemSecretKey,opened:{mode:"fresh"}});pin.installationId="99999999-9999-9999-9999-999999999999";expect(()=>rt.signCpEnrol(Buffer.alloc(32,11))).toThrow();expect(f.x.rt_app_cp_enrol_sign).not.toHaveBeenCalled();expect(f.x.rt_app_device_retire).toHaveBeenCalledTimes(1);expect(f.sql.fence).not.toHaveBeenCalled();await rt.close();
  });
  it("verifies through actual same-runtime local session identity, not guessed IDs/foreign ports", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    const source = { collection: COLLECTION, deviceId: config().deviceId, isCurrent: () => true }, witness = Buffer.from([1, 2, 3]);
    const port = rt.connect(); expect(rt.verifyHandover(port, source, witness)).toBeNull(); expect(f.x.rt_app_verify_handover).not.toHaveBeenCalled();
    port.send(new Map()); await Promise.resolve();
    expect(rt.verifyHandover(port, source, witness)).toMatchObject({ seq: 1, chain: `sha256:${"01".repeat(32)}` });
    expect(f.x.rt_app_verify_handover.mock.calls[0]?.[0]).toBe(8n); expect([...witness]).toEqual([1, 2, 3]);
    expect(rt.verifyHandover({ ...port }, source, witness)).toBeNull(); expect(rt.verifyHandover(port, { ...source, isCurrent: () => false }, witness)).toBeNull();
    port.close(); expect(rt.verifyHandover(port, source, witness)).toBeNull(); expect(f.sql.fence).not.toHaveBeenCalled(); await rt.close();
  });
  it("pins CP connector once before LS binding and signs only fixed token purpose", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    const pin = { connectorId: "66666666-6666-6666-6666-666666666666", deviceId: config().deviceId, collection: COLLECTION, isCurrent: () => true };
    expect(() => rt.signCpLogToken(new Uint8Array(32))).toThrow();
    expect(() => rt.bindCpConnector({ ...pin, deviceId: "77777777-7777-7777-7777-777777777777" })).toThrow();
    expect(f.x.rt_app_cp_bind_connector).not.toHaveBeenCalled(); rt.bindCpConnector(pin); expect(() => rt.bindCpConnector(pin)).toThrow();
    const borrowed = Buffer.alloc(32, 0x11); expect(rt.signCpLogToken(borrowed)).toHaveLength(64); expect(borrowed.every(b => b === 0x11)).toBe(true); expect(() => rt.signCpLogToken(new Uint8Array(31))).toThrow();
    pin.isCurrent = () => false; expect(() => rt.signCpLogToken(new Uint8Array(32))).toThrow();
    expect(f.retire).toHaveBeenCalledTimes(1); expect(f.sql.fence).not.toHaveBeenCalled(); expect(await rt.close()).toBe(true);
  });
  it("authenticated wake drains old pump without retiring SAME owner and increments native generation",async()=>{
    const f=await fixture(),rt=await f.create();rt.openAppConsuming(config());const transport={endpoint:37,collection:COLLECTION,isCurrent:()=>true,send:async()=>new Uint8Array()};const old=rt.bindLogTransport(transport);const next=await rt.reconnectLogTransport(transport);expect(next).not.toBe(old);expect(f.retire).not.toHaveBeenCalled();expect(f.x.rt_app_log_reconnect).toHaveBeenCalledTimes(1);expect(await next.pump()).toEqual({quiet:true});await old.close();expect(f.retire).not.toHaveBeenCalled();await rt.close();expect(f.retire).toHaveBeenCalledTimes(1);
  });
  it("requires app exports/import factory and refuses legacy before key/SQL activation", async () => {
    const f = await fixture("legacy"); await expect(f.create()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.x.rt_open).not.toHaveBeenCalled();
  });
  it("encodes all explicit authority pins and consumes both transient device keys", async () => {
    const f = await fixture(), rt = await f.create(), c = config();
    try {
      rt.openAppConsuming(c);
      expect(f.pins().size).toBe(15); expect(f.pins().get(0)).toBe(3); expect(f.pins().get(16)).toEqual(c.policyPins); expect(f.pins().get(4)).toBe(37);
      expect(f.pins().get(7)).toEqual(new Uint8Array(32).fill(8)); expect(f.pins().get(8)).toBe(0); expect(f.pins().get(9)).toBe(false); expect(f.pins().get(12)).toBe(1);
      expect(c.signSecretKey.every(b => b === 0)).toBe(true); expect(c.kemSecretKey.every(b => b === 0)).toBe(true); expect(f.encoded().every(b => b === 0)).toBe(true);
      expect(typeof f.imports().env!.host_app_sql).toBe("function");
      expect(rt.observations()).toMatchObject({ snapshotInstallAvailable: true, requiresReopen: false, status: { mode: "synced", pending: 0 } });
    } finally { rt.dispose(); }
  });
  it.each(["refused", "trap", "allocation"] as const)("fences/discards/wipes after %s, never retries or exposes raw detail", async outcome => {
    const f = await fixture(outcome), rt = await f.create(), c = config();
    expect(() => rt.openAppConsuming(c)).toThrow("app runtime unavailable; reopen and reconcile");
    expect(c.signSecretKey.every(b => b === 0)).toBe(true); expect(c.kemSecretKey.every(b => b === 0)).toBe(true); expect(f.encoded().every(b => b === 0)).toBe(true);
    expect(f.sql.fence).toHaveBeenCalled(); expect(() => rt.observations()).toThrow();
    const second = config(); expect(() => rt.openAppConsuming(second)).toThrow(); expect(second.signSecretKey.every(b => b === 0)).toBe(true);
    expect(f.x.rt_open).not.toHaveBeenCalled();
  });
  it.each(["trustedRoots", "expectedGenesis", "state", "cloudCopyOptIn", "sqliteVersion"] as const)("refuses malformed %s before ABI side effects and wipes", async key => {
    const f = await fixture(), rt = await f.create(), c = config();
    Object.assign(c, { [key]: key === "trustedRoots" ? [] : key === "state" ? "unknown" : key === "expectedGenesis" ? "not-a-hash" : key === "cloudCopyOptIn" ? true : Number.MAX_SAFE_INTEGER });
    expect(() => rt.openAppConsuming(c)).toThrow(); expect(f.pins()).toBeNull(); expect(c.signSecretKey.every(b => b === 0)).toBe(true);
    expect(f.x.rt_open).not.toHaveBeenCalled();
  });
  it("refuses legacy open/reopen and exposes no new host entry in thin root", async () => {
    const f = await fixture(), rt = await f.create();
    expect(() => rt.open({ ...config(), mode: "synced" })).toThrow(); expect(f.x.rt_open).not.toHaveBeenCalled();
    rt.openAppConsuming(config()); expect(rt.shutdown()).toBe(true);
    expect(() => rt.openAppConsuming(config())).toThrow(); expect(f.shutdown).toHaveBeenCalledTimes(1);
    const root = await import("../src/index.js"); expect("AppWasmRuntime" in root).toBe(false);
  });
  it("requires a current matching transport, retires/drains before shutdown, and rejects late replies", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    const transport = { endpoint: 37, collection: COLLECTION, isCurrent: () => true, send: vi.fn(async () => new Uint8Array()) };
    expect(() => rt.bindLogTransport({ ...transport, endpoint: 38 })).toThrow(); expect(f.bind).not.toHaveBeenCalled();
    expect(() => rt.bindLogTransport({ ...transport, isCurrent: () => false })).toThrow();
    rt.bindLogTransport(transport); expect(f.bind).toHaveBeenCalledTimes(1);
    expect(await rt.close()).toBe(true); expect(f.retire).toHaveBeenCalled(); expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(rt.acceptLogReply(1n, new Uint8Array())).toBe(false); expect(f.reply).not.toHaveBeenCalled();
  });
  it("undrained synchronous dispose fences clean marker instead of claiming clean shutdown", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    rt.bindLogTransport({ endpoint: 37, collection: COLLECTION, isCurrent: () => true, send: async () => new Uint8Array() });
    expect(rt.shutdown()).toBe(false); expect(f.sql.fence).toHaveBeenCalled(); expect(f.shutdown).not.toHaveBeenCalled();
  });
  it("fences service pushes to the current immutable transport generation", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    let current = true;
    expect(rt.pushLog(new Uint8Array())).toBe(false);
    rt.bindLogTransport({ endpoint: 37, collection: COLLECTION, isCurrent: () => current, send: async () => new Uint8Array() });
    current = false;
    expect(rt.pushLog(new Uint8Array())).toBe(false); expect(f.x.rt_app_log_push).not.toHaveBeenCalled(); expect(f.retire).toHaveBeenCalled();
    await rt.close();
  });
  it("signs only fixed current original-call envelopes without exposing keys or trusting JS digest", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    const p = { endpoint: 37, originalCallId: (1n << 64n) - 2n, collection: COLLECTION, path: "/v1/rpc" as const, method: "head", token: "public-fixture-token", frame: Uint8Array.of(1), nonce: new Uint8Array(32), digest: new Uint8Array(32), bodyHash: new Uint8Array(32), tokenHash: new Uint8Array(32) };
    expect(() => rt.signLogHttp(p)).toThrow(); expect(f.x.rt_app_log_http_sign).not.toHaveBeenCalled();
    rt.bindLogTransport({ endpoint: 37, collection: COLLECTION, isCurrent: () => true, send: async () => new Uint8Array() });
    expect(rt.signLogHttp(p)).toEqual(new Uint8Array(64).fill(7));
    expect(f.x.rt_app_log_http_sign.mock.calls[0]!.slice(0, 3)).toEqual([37n, 1n, p.originalCallId]);
    expect(f.encoded().every(b => b === 0)).toBe(true);
    expect(() => rt.signLogHttp({ ...p, collection: "other" })).toThrow();
    rt.retireLog(); expect(() => rt.signLogHttp(p)).toThrow(); expect(f.x.rt_app_log_http_sign).toHaveBeenCalledTimes(1);
    expect(rt.takeLogCalls()).toEqual([]); expect(() => rt.observations()).toThrow(); expect(f.sql.fence).not.toHaveBeenCalled();
    expect(await rt.close()).toBe(true);
  });
  it("ordinary signing refusal wipes envelope without treating it as an uncertain SQL trap", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config());
    rt.bindLogTransport({ endpoint: 37, collection: COLLECTION, isCurrent: () => true, send: async () => new Uint8Array() });
    f.x.rt_app_log_http_sign.mockReturnValueOnce(0n);
    expect(() => rt.signLogHttp({ endpoint: 37, originalCallId: 1, collection: COLLECTION, path: "/v1/rpc", method: "head", token: "public-fixture-token", frame: Uint8Array.of(1), nonce: new Uint8Array(32), digest: new Uint8Array(32), bodyHash: new Uint8Array(32), tokenHash: new Uint8Array(32) })).toThrow();
    expect(f.encoded().every(b => b === 0)).toBe(true); expect(f.sql.fence).not.toHaveBeenCalled(); await rt.close();
  });
  it("malformed observations fence rather than manufacture readiness", async () => {
    const f = await fixture(), rt = await f.create(); rt.openAppConsuming(config()); f.observations.delete(2);
    expect(() => rt.observations()).toThrow(); expect(f.sql.fence).toHaveBeenCalled(); expect(rt.shutdown()).toBe(false);
  });
});
