import {describe,it,expect,vi} from "vitest";
import {AppProtectedInstallationSignIn} from "../src/app-host/installation-sign-in.js";
import {AppCpDeviceRegistration} from "../src/app-host/device-registration.js";
import {AppCpPrivateBootstrap} from "../src/app-host/private-bootstrap.js";
import {AppCpLogAuthority} from "../src/app-host/cp-authority.js";
import {AppCpCloudCopyBootstrap} from "../src/app-host/cloud-copy-bootstrap.js";

// Response-reader isolation ONLY: prototype stand-ins do not create or prove
// installation/native/session authority. Existing lifecycle suites cover those.
const origin="https://cp.example.test";
const readers=[
 {name:"installation",prototype:AppProtectedInstallationSignIn.prototype,cap:64*1024,installation:true},
 {name:"device registration",prototype:AppCpDeviceRegistration.prototype,cap:32*1024},
 {name:"log authority",prototype:AppCpLogAuthority.prototype,cap:32*1024},
 {name:"private bootstrap",prototype:AppCpPrivateBootstrap.prototype,cap:1024*1024,privateOrigin:true},
 {name:"cloud-copy bootstrap",prototype:AppCpCloudCopyBootstrap.prototype,cap:1024*1024},
] as const;
for(const profile of readers)describe(`${profile.name}: decoded Fetch reader, not authority qualification`,()=>{
 function fixture(response:Response){let transportSignal:AbortSignal|undefined;
  const request=vi.fn(async(_url:unknown,init:RequestInit)=>{transportSignal=init.signal!;return response;});
  const reader=Object.assign(Object.create(profile.prototype),{check:()=>{},lifetime:new AbortController(),request,fetchImpl:request,state:{cpOrigin:origin},scope:{cpOrigin:origin},cpOrigin:origin,options:{}}) as {json:(...args:unknown[])=>Promise<unknown>;origin:unknown};
  if(!("privateOrigin" in profile))reader.origin=origin;
  return{request,signal:()=>transportSignal,read:()=>"installation" in profile?reader.json('/v1/pairing-requests',false,{}):reader.json('/v1/next/devices/challenge','fixture-only',undefined,new AbortController().signal)};
 }
 it.each(["br","gzip","hidden"])("accepts %s small wire length with larger decoded JSON",async encoding=>{
  const body=JSON.stringify({value:"a".repeat(512)}),headers:Record<string,string>={"content-length":"24"};
  if(encoding!=="hidden")headers['content-encoding']=encoding;
  const f=fixture(new Response(body,{headers}));const result=await f.read();
  expect(result).toEqual("installation" in profile?{status:200,value:JSON.parse(body)}:JSON.parse(body));
  expect(f.request).toHaveBeenCalledOnce();expect(f.signal()?.aborted).toBe(false);
 });
 it("accepts missing Content-Length without losing decoded cap",async()=>{
  const f=fixture(new Response('{"value":true}'));expect(await f.read()).toEqual("installation" in profile?{status:200,value:{value:true}}:{value:true});
 });
 it("aborts/cancels on decoded overflow despite a small compressed wire hint",async()=>{
  const cancel=vi.fn();let sent=false;
  const body=new ReadableStream<Uint8Array>({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(profile.cap+1).fill(65));}},cancel});
  const f=fixture(new Response(body,{headers:{'content-length':'8','content-encoding':'br'}}));
  await expect(f.read()).rejects.toThrow();expect(f.signal()?.aborted).toBe(true);
  await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());expect(f.request).toHaveBeenCalledOnce();
 });
 it("still early-rejects a valid declared hint already over the cap",async()=>{
  const cancel=vi.fn();const f=fixture(new Response(new ReadableStream({cancel}),{headers:{'content-length':String(profile.cap+1)}}));
  await expect(f.read()).rejects.toThrow();expect(f.signal()?.aborted).toBe(true);await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());
 });
});
