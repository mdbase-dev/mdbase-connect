import { readFileSync } from "node:fs";
import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { decode, fromHex } from "../src/cbor.js";
import { appLocalConnector, attachAppLocalFacade, type AppLocalScope } from "../src/app-host/local-facade.js";
import type { FramePort } from "../src/transport/port.js";
import type { AppBasesRequest } from "../src/app-host/bases-wire.js";
const windowFixture = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-window-codec.json", import.meta.url), "utf8")) as {cases:{request_hex:string;success_hex:string}[]};
const fullFixture = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-codec.json", import.meta.url), "utf8")) as {success_hex:string;refusal_hex:string};
const request: AppBasesRequest = {record:"11111111-1111-1111-1111-111111111111",sourceRevision:`sha256:${"22".repeat(32)}`,ordinal:3,hints:new Map([["due","date"],["scheduled","date"]]),captureTimezone:"UTC"};
const cleanup: (()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
async function clientFixture(read?: FramePort["readAppBases"], discovery?: FramePort["readAppBasesDiscovery"]) {
 const original=new MemoryReplica().connector();
 const client=await connect({connector:{description:original.description,async open(hello,signal){const opened=await original.open(hello,signal);if(read)opened.port.readAppBases=read;if(discovery)opened.port.readAppBasesDiscovery=discovery;return opened;}},app:{name:"Bases bridge stand-in",version:"0"},reconnect:false});
 cleanup.push(()=>client.close());return client;
}
const scope=():AppLocalScope=>({account:"11111111-1111-4111-8111-111111111111",installation:"22222222-2222-4222-8222-222222222222",collection:"33333333-3333-4333-8333-333333333333",isCurrent:()=>true});
async function local(read:(port:FramePort,bytes:Uint8Array)=>Uint8Array,hostScope=scope(),uiScope=scope(),discovery?:(port:FramePort,operation:"list-views"|"read-view-source",bytes:Uint8Array)=>Uint8Array) {
 const ch=new MessageChannel();cleanup.push(()=>{ch.port1.close();ch.port2.close();});
 const native:FramePort={onframe:null,onclose:null,send(frame){native.onframe?.(frame);},close(){native.onclose?.();}};
 const executeBases=vi.fn(read);
 const discoverBases=discovery?vi.fn(discovery):undefined;
 const attached=attachAppLocalFacade({connect:()=>native,executeBases,...(discoverBases?{discoverBases}:{})},ch.port1 as unknown as MessagePort,hostScope);cleanup.push(attached.close);
 const connector=appLocalConnector(ch.port2 as unknown as MessagePort,uiScope);cleanup.push(connector.close);
 const opened=await connector.open([0]);return {port:opened.port,native,executeBases,discoverBases,connector};
}
describe("native discovery held-port bridge stand-ins (not catalog/authority proof)",()=>{
 it.each(["list-views","read-view-source"] as const)("dispatches %s only on the exact native held port and copies caller input",async operation=>{
   const f=await local(()=>Uint8Array.of(9),scope(),scope(),(port,kind,bytes)=>{expect(port).toBe(f.native);expect(kind).toBe(operation);expect(bytes).toEqual(Uint8Array.of(7));return Uint8Array.of(8);});
   const caller=Uint8Array.of(7),pending=f.port.readAppBasesDiscovery!(operation,caller);caller.fill(0);
   expect(await pending).toEqual(Uint8Array.of(8));expect(f.executeBases).not.toHaveBeenCalled();expect(f.discoverBases).toHaveBeenCalledOnce();
 });
 it("retains ONE shared in-flight slot across execution and both discovery kinds after cancel",async()=>{
   const f=await local(()=>Uint8Array.of(9),scope(),scope(),()=>Uint8Array.of(8)),abort=new AbortController();
   const pending=f.port.readAppBasesDiscovery!("list-views",Uint8Array.of(1),abort.signal);abort.abort();
   await expect(pending).rejects.toMatchObject({code:"cancelled"});
   await expect(f.port.readAppBases!(Uint8Array.of(1))).rejects.toMatchObject({code:"too_large"});
   await expect(f.port.readAppBasesDiscovery!("read-view-source",Uint8Array.of(1))).rejects.toMatchObject({code:"too_large"});
   await new Promise(resolve=>setTimeout(resolve,20));
   expect(await f.port.readAppBasesDiscovery!("read-view-source",Uint8Array.of(1))).toEqual(Uint8Array.of(8));
   expect(f.discoverBases).toHaveBeenCalledTimes(2);expect(f.executeBases).not.toHaveBeenCalled();
 });
 it("refuses unknown operation and oversized discovery output, never routes to execution",async()=>{
   const f=await local(()=>Uint8Array.of(9),scope(),scope(),()=>new Uint8Array(1024*1024+1));
   await expect(f.port.readAppBasesDiscovery!("unknown" as "list-views",Uint8Array.of(1))).rejects.toMatchObject({code:"invalid_request"});
   expect(f.discoverBases).not.toHaveBeenCalled();
   await expect(f.port.readAppBasesDiscovery!("list-views",Uint8Array.of(1))).rejects.toMatchObject({code:"unavailable"});
   expect(f.executeBases).not.toHaveBeenCalled();
 });
 it("fails on scope loss during native discovery and wipes abandoned metadata",async()=>{
   let current=true;const abandoned=Uint8Array.of(8),f=await local(()=>Uint8Array.of(9),{...scope(),isCurrent:()=>current},scope(),()=>{current=false;return abandoned;});
   await expect(f.port.readAppBasesDiscovery!("list-views",Uint8Array.of(1))).rejects.toMatchObject({code:"unavailable"});expect(abandoned.every(v=>v===0)).toBe(true);
 });
 it("SDK missing metadata transport refuses without legacy list/execute fallback",async()=>{
   const client=await clientFixture(),list=vi.spyOn(client,"listViews"),exec=vi.spyOn(client,"executeView");
   await expect(client.listAppBasesViews({captureTimezone:"UTC",limit:128})).rejects.toMatchObject({code:"invalid_request",reason:"unsupported"});
   await expect(client.readAppBasesViewSource({record:request.record,sourceRevision:request.sourceRevision,ordinal:3,captureTimezone:"UTC"})).rejects.toMatchObject({code:"invalid_request",reason:"unsupported"});
   expect(list).not.toHaveBeenCalled();expect(exec).not.toHaveBeenCalled();
 });
 it("closed original metadata session suppresses/wipes reply, no session replay",async()=>{
   const abandoned=Uint8Array.of(8),client=await clientFixture(undefined,async()=>{client.close();return abandoned;});
   await expect(client.listAppBasesViews({captureTimezone:"UTC",limit:128})).rejects.toMatchObject({code:"unavailable"});expect(abandoned.every(v=>v===0)).toBe(true);
 });
});
describe("Bases READ bridge stand-ins (not native authority/execution/render proof)",()=>{
 it("uses exact held port bytes and independent request echo, without generic RPC fallback",async()=>{
  const read=vi.fn(async(bytes:Uint8Array)=>{expect(bytes).toEqual(fromHex(windowFixture.cases[0]!.request_hex));return fromHex(windowFixture.cases[0]!.success_hex);});
  const client=await clientFixture(read),legacy=vi.spyOn(client,"executeView"),typedLegacy=vi.spyOn(client.views,"execute");
  const result=await client.executeAppBases({...request,window:{offset:0,limit:200}});
  expect(result.kind==="success"&&result.window?.totalMatchedRows).toBe(1);expect(read).toHaveBeenCalledOnce();expect(legacy).not.toHaveBeenCalled();expect(typedLegacy).not.toHaveBeenCalled();
 });
 it("keeps legacy full shape and native Problem refusals",async()=>{
  for(const hex of [fullFixture.success_hex,fullFixture.refusal_hex]){const client=await clientFixture(async()=>fromHex(hex));const result=await client.executeAppBases(request);expect("window" in result).toBe(false);expect(result.kind).toBe(hex===fullFixture.success_hex?"success":"refusal");}
 });
 it("refuses transports without bridge, without restarting/fallback",async()=>{
  const client=await clientFixture(),fallback=vi.spyOn(client.views,"execute");
  await expect(client.executeAppBases(request)).rejects.toMatchObject({code:"invalid_request",reason:"unsupported"});expect(fallback).not.toHaveBeenCalled();
 });
 it("rejects an original session closed during its awaited read",async()=>{
  const client=await clientFixture(async()=>{client.close();return fromHex(fullFixture.success_hex);});
  await expect(client.executeAppBases(request)).rejects.toMatchObject({code:"unavailable"});
 });
 it("rejects already-aborted reads before transport work and abort after reply",async()=>{
  const read=vi.fn(async()=>fromHex(fullFixture.success_hex)),client=await clientFixture(read);
  await expect(client.executeAppBases(request,AbortSignal.abort())).rejects.toMatchObject({code:"cancelled"});expect(read).not.toHaveBeenCalled();
  const abort=new AbortController(),other=await clientFixture(async()=>{abort.abort();return fromHex(fullFixture.success_hex);});
  await expect(other.executeAppBases(request,abort.signal)).rejects.toMatchObject({code:"cancelled"});
 });
 it("captures window echo before await, rejects wrong response and oversized output",async()=>{
  const window={offset:0,limit:200},client=await clientFixture(async()=>{window.offset=1;return fromHex(windowFixture.cases[0]!.success_hex);});
  expect((await client.executeAppBases({...request,window})).kind).toBe("success");
  const wrong=await clientFixture(async()=>fromHex(windowFixture.cases[0]!.success_hex));await expect(wrong.executeAppBases({...request,window:{offset:1,limit:200}})).rejects.toMatchObject({code:"internal"});
  const large=await clientFixture(async()=>new Uint8Array(16*1024*1024+1));await expect(large.executeAppBases(request)).rejects.toMatchObject({code:"internal"});
 });
 it("transfers independently owned input/reply for the exact Worker-held native port",async()=>{
  const f=await local((port,bytes)=>{expect(port).toBe(f.native);expect(bytes).toEqual(fromHex(windowFixture.cases[0]!.request_hex));return fromHex(windowFixture.cases[0]!.success_hex);});
  const borrowed=fromHex(windowFixture.cases[0]!.request_hex),promise=f.port.readAppBases!(borrowed);borrowed.fill(0);
  expect(await promise).toEqual(fromHex(windowFixture.cases[0]!.success_hex));expect(f.executeBases).toHaveBeenCalledOnce();
 });
 it("scope loss during execution suppresses the entire reply and wipes abandoned bytes",async()=>{
  let current=true;const abandoned=fromHex(fullFixture.success_hex),f=await local(()=>{current=false;return abandoned;},{...scope(),isCurrent:()=>current});
  await expect(f.port.readAppBases!(Uint8Array.of(1))).rejects.toMatchObject({code:"unavailable"});expect(abandoned.every(byte=>byte===0)).toBe(true);
 });
 it("scope loss before dispatch prevents native work",async()=>{
  let current=true;const f=await local(()=>fromHex(fullFixture.success_hex),scope(),{...scope(),isCurrent:()=>current});current=false;
  await expect(f.port.readAppBases!(Uint8Array.of(1))).rejects.toMatchObject({code:"unavailable"});expect(f.executeBases).not.toHaveBeenCalled();
 });
 it("cancellation retains one bounded in-flight slot until original reply, no queued/restarted work",async()=>{
  const f=await local(()=>fromHex(fullFixture.success_hex)),abort=new AbortController(),first=f.port.readAppBases!(Uint8Array.of(1),abort.signal);abort.abort();
  await expect(first).rejects.toMatchObject({code:"cancelled"});await expect(f.port.readAppBases!(Uint8Array.of(1))).rejects.toMatchObject({code:"too_large"});
  await new Promise(resolve=>setTimeout(resolve,20));expect(f.executeBases).toHaveBeenCalledOnce();
  expect(decode(await f.port.readAppBases!(Uint8Array.of(1)))).toBeInstanceOf(Map);expect(f.executeBases).toHaveBeenCalledTimes(2);
 });
 it("bounds request before transfer and rejects close while awaiting reply",async()=>{
  const f=await local(()=>fromHex(fullFixture.success_hex));await expect(f.port.readAppBases!(new Uint8Array(128*1024+1))).rejects.toMatchObject({code:"invalid_request"});expect(f.executeBases).not.toHaveBeenCalled();
  const pending=f.port.readAppBases!(Uint8Array.of(1));f.connector.close();await expect(pending).rejects.toMatchObject({code:"unavailable"});
 });
});
