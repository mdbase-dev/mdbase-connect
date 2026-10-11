// Real Engine host methods/ControlClient over fake native exports + fetch only.
// No native Noise/custody/managed runtime evidence from these wrapper tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { ControlClient } from "../src/control.ts";
import { decodePitrAppQuery } from "../src/pitr-app-query.ts";
import { PITR_RUN } from "../src/pitr-phase.ts";
import { encode, decode } from "../../../packages/sdk/src/cbor.ts";
const compiled=await build({entryPoints:[new URL("../src/engine.ts",import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{
  name:"empty-native-import",setup(b){b.onLoad({filter:/hosted\.wasm$/},()=>({contents:"export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));"}));},
}]});
const {Engine}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const active="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",deleted="dddddddd-dddd-4ddd-addd-dddddddddddd";
const bytes=(s)=>Uint8Array.from(Buffer.from(s.replaceAll("-",""),"hex"));
const tuple=()=>[bytes(active),bytes("44444444-4444-4444-a444-444444444444"),new Uint8Array(32).fill(0xee),new Uint8Array(32).fill(0xbb),new Uint8Array(16).fill(0xcc)];
const identity=()=>decodePitrAppQuery(tuple());
const binding={run:PITR_RUN,active,deleted,codeConfigSha256:"aa".repeat(32),members:[
  ...[active,deleted].map((collection,i)=>({kind:"log",collection,namespace:"01".repeat(16),object:`0${i+1}`.repeat(32)})),
  {kind:"registry",collection:"00000000-0000-0000-0000-000000000000",namespace:"01".repeat(16),object:"03".repeat(32)},
  ...[active,deleted].map((collection,i)=>({kind:"hosted",collection,namespace:"02".repeat(16),object:`0${i+4}`.repeat(32)})),
]};
const config={url:"https://connect-lab.mdbase.dev",token:"h".repeat(40),pitr:{binding,token:"p".repeat(40)}};
function native(){
  const e=Object.create(Engine.prototype),memory=new WebAssembly.Memory({initial:2});let at=32;
  const s={calls:[],allocations:0,query:tuple(),wake:3n,admission:[1,1,new Uint8Array(32).fill(3)]};
  const alloc=n=>{s.allocations++;const p=at;at+=Math.max(n,1);return p;};
  const pack=b=>{const p=alloc(b.length);new Uint8Array(memory.buffer,p,b.length).set(b);return (BigInt(p)<<32n)|BigInt(b.length);};
  e.ex={memory,alloc,dealloc:()=>{},hd_pitr_app_query:(h,p,n)=>{s.calls.push({h,input:new Uint8Array(memory.buffer,p,n).slice()});return pack(encode(s.query));},
    hd_admission:()=>pack(encode(s.admission)),hd_wake_instance:()=>{const b=new Uint8Array(8);new DataView(b.buffer).setBigUint64(0,s.wake);return pack(b);}};
  return {e,s};
}
const decl=()=>encode([new Uint8Array(16).fill(1)]);
const signal=()=>new AbortController();
const point=(before=()=>{},body=undefined)=>new ControlClient(config,async(url,options)=>{
  assert.equal(new URL(url).pathname,"/internal/v1/next/lab-pitr/current-app-grant");
  assert.equal(options.method,"POST");const request=JSON.parse(options.body);
  assert.deepEqual(request,{run:PITR_RUN,...identity()});
  await before();return Response.json(body??{...request,current:true,checkedAt:1000});
},()=>1000);

test("query tuple is strict frozen public data, with no extra permit fields or byte aliases",()=>{
  const t=tuple(),i=decodePitrAppQuery(t);assert.ok(i);assert.ok(Object.isFrozen(i));assert.deepEqual(Object.keys(i).sort(),["principal","collection","grant","clientPublicKey","genesisSha256","policyKeyId"].sort());
  t[2].fill(0);assert.equal(i.clientPublicKey,"ee".repeat(32));
  for(const bad of [null,{},[],[...tuple(),true],tuple().slice(1)])assert.equal(decodePitrAppQuery(bad),null);
  for(let k=0;k<5;k++)for(const value of ["claim",new Uint8Array(1),new Uint8Array(tuple()[k].length)]){const t=tuple();t[k]=value;assert.equal(decodePitrAppQuery(t),null);}
});

test("host wrapper refuses invalid handles/oversize before native allocation and only forwards exact input",()=>{
  const {e,s}=native();
  for(const h of [0,-1,1.1,0x100000000,NaN,Infinity])assert.equal(e.pitrAppQuery(h,decl()),null);
  for(const d of [new Uint8Array(),new Uint8Array(513),null,{}])assert.equal(e.pitrAppQuery(1,d),null);
  assert.equal(s.allocations,0);assert.deepEqual(e.pitrAppQuery(17,decl()),identity());
  assert.equal(s.calls.length,1);assert.equal(s.calls[0].h,17);assert.deepEqual(s.calls[0].input,decl());
  s.query=[];assert.equal(e.pitrAppQuery(17,decl()),null);
});

test("uncached real CP point is void and rechecks native after await without mutating declarations",async()=>{
  const {e,s}=native(),d=decl(),before=d.slice();let calls=0;
  const cp=point(()=>{calls++;});
  assert.equal(await e.assertPitrAppCurrent(17,d,cp,signal().signal),undefined);
  assert.equal(s.calls.length,2);assert.equal(calls,1);assert.deepEqual(d,before);
  await e.assertPitrAppCurrent(17,d,cp,signal().signal);assert.equal(calls,2,"no cached native/CP permit");
});

test("native refusal or already-aborted signal never dispatches CP",async()=>{
  const {e,s}=native();let calls=0;const cp=point(()=>{calls++;});s.query=[];
  await assert.rejects(e.assertPitrAppCurrent(17,decl(),cp,signal().signal));
  s.query=tuple();const a=signal();a.abort();await assert.rejects(e.assertPitrAppCurrent(17,decl(),cp,a.signal));
  assert.equal(calls,0);
});

test("wake/head/generation/Noise/declaration and abort drift at CP await refuse",async()=>{
  for(const mode of ["wake","head","noise","declarations","abort"]){
    const {e,s}=native(),d=decl(),a=signal();const cp=point(()=>{
      if(mode==="wake")s.wake++;
      if(mode==="head")s.admission[1]++;
      if(mode==="noise")s.query=[];
      if(mode==="declarations")d[0]^=1;
      if(mode==="abort")a.abort();
    });
    await assert.rejects(e.assertPitrAppCurrent(17,d,cp,a.signal),/pitr_app_current_not_established/,mode);
  }
  const {e,s}=native();const cp=point(()=>{s.query[2].fill(1);});
  await assert.rejects(e.assertPitrAppCurrent(17,decl(),cp,signal().signal),/pitr_app_current_not_established/);
});

test("current CP outage/denial/mismatched echo refuse without native output authorization",async()=>{
  const {e,s}=native();
  const absent=new ControlClient(config,async()=>{throw new Error("offline");},()=>1000);
  await assert.rejects(e.assertPitrAppCurrent(17,decl(),absent,signal().signal));
  for(const body of [{...identity(),run:PITR_RUN,current:false,checkedAt:1000},{...identity(),run:PITR_RUN,current:true,checkedAt:1000,grant:"11111111-1111-4111-a111-111111111111"}]){
    await assert.rejects(e.assertPitrAppCurrent(17,decl(),point(()=>{},body),signal().signal));
  }
  assert.equal(s.calls.length,3,"CP failure cannot complete a native post-check");
});
