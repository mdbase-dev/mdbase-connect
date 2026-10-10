import {describe,it,expect,vi} from "vitest";
import {createHash} from "node:crypto";
import {AppCpPrivateBootstrap,type AppCpPrivateSession,type AppPrivateBootstrapPersistence} from "../src/app-host/private-bootstrap.js";
import type {AppWasmRuntime,AppPrivateEnrolOperationMarker} from "../src/app-host/wasm-runtime.js";
async function fixture(purpose:"create"|"enrol"="create",acknowledged=false){
 const now=1700000000000,events:string[]=[],signal=new AbortController().signal;
 const session:AppCpPrivateSession={connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:"88888888-8888-8888-8888-888888888888",collection:"22222222-2222-2222-2222-222222222222",accountId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",purpose,approvalMode:"password-ak1",cpOrigin:"https://cp.example",logOrigin:"https://log.example",rootPublicKey:new Uint8Array(32).fill(9),isCurrent:()=>true,connectorBearer:async()=>{events.push("bearer");return "private-credential";}};
 const receipt={connectorId:session.connectorId,deviceId:session.deviceId,installationId:session.installationId,signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3)};
 const marker:AppPrivateEnrolOperationMarker={...receipt,collection:session.collection,sasCommitment:new Uint8Array(32).fill(11),acknowledged};
 let current=true;
 const runtime={privateCollectionCurrent:vi.fn((s?:AppCpPrivateSession)=>current&&(!s||s.connectorId===session.connectorId&&s.deviceId===session.deviceId&&s.collection===session.collection)),privateEnrolMarker:()=>marker,registeredDeviceReceipt:()=>receipt,signPrivateCreate:vi.fn(()=>new Uint8Array(64).fill(12)),signPrivateDeviceEnrol:vi.fn(()=>({signature:new Uint8Array(64).fill(13),sasCommitment:new Uint8Array(marker.sasCommitment)})),retireLog:vi.fn(()=>{current=false;})};
 const persistence:AppPrivateBootstrapPersistence={pendingCreate:vi.fn(async()=>{events.push("pending-create");}),privateEnrolPending:vi.fn(async()=>{events.push("pending-enrol");}),completed:vi.fn(async()=>{events.push("completed");}),privateEnrolAcknowledged:vi.fn(async()=>{events.push("ack");}),restoredCompletion:vi.fn(async()=>null)};
 const response={collection_id:session.collection,state:"private",owner_account:session.accountId,root_public_key:"09".repeat(32),log_url:session.logOrigin,genesis:{seq:1,item:"01"},approval:"pending",enrolled_at:2,device:{device_id:session.deviceId,token:"private-log-token",expires_at:now+60000}};
 const fetch=vi.fn(async(url:string,init:RequestInit)=>{events.push(url.endsWith("challenge")?"challenge":"post");expect(init.redirect).toBe("error");expect(init.credentials).toBe("omit");return new Response(JSON.stringify(url.endsWith("challenge")?{challenge:"11".repeat(32),expires_at:now+60000}:response));});
 const create=(displayName?:string)=>new AppCpPrivateBootstrap(runtime as unknown as AppWasmRuntime,session,persistence,{fetch:fetch as unknown as typeof globalThis.fetch,now:()=>now,...(displayName===undefined?{}:{displayName})});
 return {now,events,signal,session,marker,runtime,persistence,response,fetch,create};
}
describe("bounded fixed-purpose private HTTP host (mock receiver, not bootstrap verification)",()=>{
 it("private initial cleartext label is captured/protected before HTTP without changing native signing",async()=>{
  const f=await fixture(),result=await f.create("  Research  ").bootstrap({signal:f.signal});
  expect(f.events).toEqual(["pending-create","bearer","challenge","post","completed"]);
  expect(vi.mocked(f.persistence.pendingCreate).mock.calls[0]![0]).toMatchObject({collection:f.session.collection,displayName:"Research"});
  expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string).display_name).toBe("Research");
  expect(result.displayName).toBe("Research");expect(f.runtime.signPrivateCreate).toHaveBeenCalledTimes(1);
 });
 it("raw invalid label and initial label on enrol refuse before any async or HTTP",async()=>{
  const f=await fixture();expect(()=>f.create("Research\n")).toThrow("binding");expect(f.fetch).not.toHaveBeenCalled();expect(f.persistence.restoredCompletion).not.toHaveBeenCalled();
  const enrol=await fixture("enrol");expect(()=>enrol.create("Research")).toThrow("binding");expect(enrol.fetch).not.toHaveBeenCalled();
 });
 it.each(["create","enrol"] as const)("protects outcome before %s POST, exact scope and no token persistence",async purpose=>{
  const f=await fixture(purpose),host=f.create(),result=await host.bootstrap({signal:f.signal});
  expect(f.events).toEqual(purpose==="create"?["pending-create","bearer","challenge","post","completed"]:["pending-enrol","bearer","challenge","post","completed","ack"]);
  const body=JSON.parse(f.fetch.mock.calls[1]![1]!.body as string);expect(body.device_id).toBe(f.session.deviceId);expect(body.challenge).toBe("11".repeat(32));expect(body.sig).toBe((purpose==="create"?"0c":"0d").repeat(64));
  if(purpose==="enrol")expect(body.sas_commit).toBe("0b".repeat(32));else expect(body.collection_id).toBe(f.session.collection);
  const domain=Buffer.from("mdbase/v1/chain"),expected=createHash("sha256").update(Uint8Array.of(domain.length)).update(domain).update(Uint8Array.of(1)).digest("hex");expect(result.expectedGenesis).toBe(`sha256:${expected}`);expect(result.approval).toBe(purpose==="create"?"creator":"pending");
  expect(JSON.stringify(result)).not.toContain("token");expect(JSON.stringify(vi.mocked(f.persistence.completed).mock.calls)).not.toContain("private-log-token");
  await expect(host.bootstrap({signal:f.signal})).rejects.toMatchObject({reason:"fenced"});expect(f.fetch).toHaveBeenCalledTimes(2);
 });
 it("acknowledged restored enrol reads protected genuine completion without another proof/HTTP",async()=>{
  const f=await fixture("enrol",true);const stored={collection:f.session.collection,deviceId:f.session.deviceId,logOrigin:f.session.logOrigin,rootPublicKey:f.session.rootPublicKey,genesisItem:Uint8Array.of(1),expectedGenesis:`sha256:${"11".repeat(32)}`,approval:"pending" as const};vi.mocked(f.persistence.restoredCompletion).mockResolvedValue(stored);
  const result=await f.create().bootstrap({signal:f.signal});expect(result.genesisItem).not.toBe(stored.genesisItem);expect(f.fetch).not.toHaveBeenCalled();expect(f.runtime.signPrivateDeviceEnrol).not.toHaveBeenCalled();expect(f.persistence.privateEnrolPending).not.toHaveBeenCalled();
 });
 it.each(["create","enrol"] as const)("known committed %s completion avoids another proof/POST; repairs only enrol ACK",async purpose=>{
  const f=await fixture(purpose),stored={collection:f.session.collection,deviceId:f.session.deviceId,logOrigin:f.session.logOrigin,rootPublicKey:new Uint8Array(f.session.rootPublicKey),genesisItem:Uint8Array.of(1),expectedGenesis:`sha256:${"11".repeat(32)}`,approval:purpose==="create"?"creator" as const:"pending" as const};vi.mocked(f.persistence.restoredCompletion).mockResolvedValue(stored);
  expect(await f.create().bootstrap({signal:f.signal})).toEqual(stored);expect(f.fetch).not.toHaveBeenCalled();expect(f.runtime.signPrivateCreate).not.toHaveBeenCalled();expect(f.runtime.signPrivateDeviceEnrol).not.toHaveBeenCalled();expect(f.persistence.pendingCreate).not.toHaveBeenCalled();expect(f.persistence.privateEnrolPending).not.toHaveBeenCalled();expect(f.persistence.privateEnrolAcknowledged).toHaveBeenCalledTimes(purpose==="enrol"?1:0);
 });
 it("acknowledged enrol with missing protected completion refuses; never reproves",async()=>{
  const f=await fixture("enrol",true);await expect(f.create().bootstrap({signal:f.signal})).rejects.toMatchObject({reason:"response"});expect(f.fetch).not.toHaveBeenCalled();expect(f.runtime.signPrivateDeviceEnrol).not.toHaveBeenCalled();
 });
 it("platform callbacks cannot mutate retained public commitment before POST",async()=>{
  const f=await fixture("enrol");vi.mocked(f.persistence.privateEnrolPending).mockImplementationOnce(async marker=>{marker.sasCommitment.fill(0);marker.noisePublicKey.fill(0);});
  await f.create().bootstrap({signal:f.signal});const body=JSON.parse(f.fetch.mock.calls[1]![1]!.body as string);expect(body.sas_commit).toBe("0b".repeat(32));expect(f.marker.sasCommitment.every(v=>v===11)).toBe(true);expect(f.marker.noisePublicKey.every(v=>v===3)).toBe(true);
 });
 it("lost native owner after protected pending await fences before bearer/HTTP",async()=>{
  const f=await fixture("enrol");vi.mocked(f.persistence.privateEnrolPending).mockImplementationOnce(async()=>{f.runtime.retireLog();});await expect(f.create().bootstrap({signal:f.signal})).rejects.toMatchObject({reason:"fenced"});expect(f.fetch).not.toHaveBeenCalled();expect(f.events).not.toContain("bearer");
 });
 it.each(["root","collection","device","approval","log","genesis"])("invalid receiver %s refuses completion and preserves pending",async field=>{
  const f=await fixture(field==="approval"?"enrol":"create");switch(field){case"root":f.response.root_public_key="08".repeat(32);break;case"collection":f.response.collection_id="33333333-3333-3333-3333-333333333333";break;case"device":f.response.device.device_id="33333333-3333-3333-3333-333333333333";break;case"approval":f.response.approval="approved";break;case"log":f.response.log_url="https://foreign.example";break;case"genesis":f.response.genesis.seq=2;break;}
  await expect(f.create().bootstrap({signal:f.signal})).rejects.toMatchObject({reason:"response"});expect(f.persistence.completed).not.toHaveBeenCalled();expect(f.persistence.privateEnrolAcknowledged).not.toHaveBeenCalled();expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.runtime.retireLog).toHaveBeenCalled();
 });
});
