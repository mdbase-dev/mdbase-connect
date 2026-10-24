// Host callback/transport mechanics ONLY. Native, phase and storage are mocked;
// synthetic sequencing/envelope bytes are not a caller, signature or H0 proof.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
globalThis.__prekeyFetch = () => assert.fail("unexpected CP transport");
const bundled=await build({entryPoints:[new URL("../../cloudflare-do/src/pitr-worker.mjs",import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-native-ports",setup(b){
  b.onLoad({filter:/cloudflare-do\/src\/pitr-worker\.mjs$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(state|work|restriction|cut|stopResources|native|source)\b/g,"test_$1").replace("globalThis.fetch.bind(globalThis)","(...args) => globalThis.__prekeyFetch(...args)"),loader:"js"}));
  b.onResolve({filter:/build\/worker\/shim\.mjs$/},()=>({path:"native",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},()=>({contents:`export class LogCollection {
    constructor(state,env){if(env.LOGSVC_PITR_REQUIRED!=="1")throw Error("ordinary constructor");this.nativeState=state;}
    async prekeyBegin(request){this.nativeState.calls.push("begin");return this.nativeState.begin(request);}
    prekeyAccept(h,bytes){this.nativeState.calls.push(["accept",h,Array.from(bytes)]);this.nativeState.accept(h,bytes);}
    prekeyCurrent(h){this.nativeState.calls.push(["current",h]);this.nativeState.current(h);}
    prekeyFinish(h){this.nativeState.calls.push(["finish",h]);this.nativeState.finish(h);}
    fetch(){throw Error("ordinary fetch");}
    async alarm(){await this.nativeState.storage.deleteAlarm();}
    async webSocketMessage(){} async webSocketClose(){} async webSocketError(){}
  }`}));
}}]});
const {default:worker,LogCollection}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const beginBytes=h=>{let head;if(h<24)head=[h];else if(h<256)head=[24,h];else if(h<65536)head=[25,h>>8,h&255];else if(h<4294967296)head=[26,...Array.from({length:4},(_,i)=>Number((BigInt(h)>>BigInt(24-8*i))&255n))];else head=[27,...Array.from({length:8},(_,i)=>Number((BigInt(h)>>BigInt(56-8*i))&255n))];return Uint8Array.from([0x82,...head,0x58,32,...Array(32).fill(9)]);};
function fixture({collection=A,begin,accept,current,finish,origin="https://cp.example",transport}={}){
  const calls=[],text=c=>c===A?"01".repeat(32):c===D?"02".repeat(32):"03".repeat(32);
  const id=(c,s="log")=>({c,s,toString:()=>text(c),equals:o=>o.c===c&&o.s===s});
  const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
    ...[A,D].map(c=>({kind:"log",collection:c,namespace:"01".repeat(16),object:text(c)})),
    {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:text(NIL)},
    ...[A,D].map((c,i)=>({kind:"hosted",collection:c,namespace:"02".repeat(16),object:(i?"05":"04").repeat(32)}))]};
  let phase="seed",epoch=7,lifetime=0;const issuedAt=Date.now()-1000,expiresAt=Date.now()+600000;
  const state={id:id(collection),calls,waitUntil(p){calls.push("waitUntil");void p.catch(()=>{});},setWebSocketAutoResponse(){},getWebSockets(){return [];},
    begin:begin??(async request=>{calls.push(["request",request.url,request.headers.get("authorization"),request.headers.get("x-test-nonce"),await request.text()]);return beginBytes(1);}),
    accept:accept??(()=>{}),current:current??(()=>{}),finish:finish??(()=>{}),
    storage:{get sql(){assert.fail("SQL");},async deleteAlarm(){calls.push("deleteAlarm");},async sync(){calls.push("sync");},async getCurrentBookmark(){calls.push("bookmark");return "synthetic-cut";}},abort(){assert.fail("restart");}};
  const env={CP_URL:origin,PITR_AUTHORITY_TOKEN:"synthetic-authority-token",PITR_BINDING:JSON.stringify(binding),PITR_MINIMUM_EPOCH:"1",
    PITR_PHASE:{async get(){calls.push("phase");const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch,phase,issuedAt,expiresAt:expiresAt+lifetime}));return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};}},
    LOG:{idFromName:c=>id(c),get(){return {fetch:request=>actor.fetch(request)};}}};
  for(const key of ["LOGSVC_URL_SECRET","OBJECTS","METRICS"])Object.defineProperty(env,key,{get(){assert.fail("private/binding "+key);}});
  const actor=new LogCollection(state,env);
  globalThis.__prekeyFetch=async(url,options)=>{calls.push(["cp",url,options]);return transport?transport(url,options):new Response(JSON.stringify({admission:"AQID",expires_at:Date.now()+1000}),{headers:{"cache-control":"no-store"}});};
  const request=()=>new Request(`https://log.example/v1/rpc?c=${collection}`,{method:"POST",headers:{authorization:"Bearer original-caller", "x-test-nonce":"original-nonce"},body:"synthetic-raw-rpc"});
  return {actor,state,env,calls,request,id,fetch:()=>actor.fetch(request()),setPhase:p=>{phase=p;},setEpoch:e=>{epoch=e;},setLifetime:n=>{lifetime=n;}};
}
test("actual request, privately captured THIS-SDK, fixed CP data transport, VOID success stays503",async()=>{
  for(const collection of [A,D]){
    const f=fixture({collection});f.env.CP_URL="https://changed.example";
    const r=await worker.fetch(f.request(),f.env);assert.equal(r.status,503);assert.equal(r.headers.get("cache-control"),"no-store");
    assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==="request"),["request",`https://log.example/v1/rpc?c=${collection}`,"Bearer original-caller","original-nonce","synthetic-raw-rpc"]);
    const cp=f.calls.find(c=>Array.isArray(c)&&c[0]==="cp");assert.equal(cp[1],"https://cp.example/internal/v1/next/lab-pitr/original-cp-admission");
    assert.deepEqual(JSON.parse(cp[2].body),{collection,challenge:"09".repeat(32)});assert.equal(cp[2].redirect,"error");assert.equal(cp[2].cache,"no-store");
    assert.equal(cp[2].headers.authorization,"Bearer synthetic-authority-token");
    assert.deepEqual(f.calls.filter(c=>Array.isArray(c)&&["accept","current","finish"].includes(c[0])),[["accept",1,[1,2,3]],["current",1],["current",1],["finish",1]]);
    assert.ok(f.actor.test_work.drained);for(const name of ["prekeyBegin","prekeyAccept","prekeyCurrent","prekeyFinish"])assert.equal(f.actor[name],undefined);
  }
});
test("nil/missing-malformed public audience never enters native begin or CP",async()=>{
  for(const options of [{collection:NIL},{origin:null},{origin:""},{origin:"http://cp.example"},{origin:"https://cp.example/"},{origin:"https://cp.example/path"},{origin:"https://user:pass@cp.example"}]){
    const f=fixture(options);
    assert.equal((await f.fetch()).status,503);assert.ok(!f.calls.includes("begin"));assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="cp"));
  }
});
test("canonical safe handle boundaries work; noncanonical/zero/oversized sequencing DATA refuses",async()=>{
  for(const h of [1,23,24,255,256,65535,65536,4294967295,4294967296,Number.MAX_SAFE_INTEGER]){const f=fixture({begin:async()=>beginBytes(h)});await f.fetch();assert.ok(f.calls.some(c=>Array.isArray(c)&&c[0]==="finish"&&c[1]===h));}
  for(const bytes of [beginBytes(0),Uint8Array.from([0x82,0x18,1,0x58,32,...Array(32).fill(9)]),new Uint8Array(45),Uint8Array.from([...beginBytes(1),0]),Uint8Array.from([0x82,1,0x58,32,...Array(32).fill(0)])]){
    const f=fixture({begin:async()=>bytes});await f.fetch();assert.ok(!f.calls.some(c=>Array.isArray(c)&&["cp","accept"].includes(c[0])));
  }
});
test("missing actual native nonce/original producer refuses before source credential/body fetch",async()=>{
  const f=fixture({begin:async()=>{throw Error("genuine nonce unavailable");}});Object.defineProperty(f.env,"PITR_AUTHORITY_TOKEN",{get(){assert.fail("credential before native input");}});
  await f.fetch();assert.ok(!f.calls.some(c=>Array.isArray(c)&&["cp","accept","finish"].includes(c[0])));assert.ok(f.actor.test_work.drained);
});
test("HTTP/JSON/base64 refusals finish matching slot, never accept a data ACK",async()=>{
  const cases=[()=>new Response("{}",{status:401}),()=>new Response("{}"),()=>new Response(JSON.stringify({admission:"AQID",expires_at:1,extra:true}),{headers:{"cache-control":"no-store"}}),
    ()=>new Response(JSON.stringify({admission:"AR==",expires_at:1}),{headers:{"cache-control":"no-store"}}),()=>new Response("x".repeat(4097),{headers:{"cache-control":"no-store"}}),
    ()=>new Response(JSON.stringify({admission:"AQID",expires_at:"1"}),{headers:{"cache-control":"no-store"}})];
  for(const transport of cases){const f=fixture({transport});await f.fetch();assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="accept"));assert.deepEqual(f.calls.at(-1),["finish",1]);assert.ok(f.actor.test_work.drained);}
});
test("accept/current faults cannot serve and always call exact finish",async()=>{
  for(const key of ["accept","current"]){const f=fixture({[key]:()=>{throw Error("native refusal");}});assert.equal((await f.fetch()).status,503);assert.deepEqual(f.calls.at(-1),["finish",1]);assert.ok(f.actor.test_work.drained);}
});
test("late native begin stays SAME work through native finish before cut sync",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let release;const f=fixture({begin:()=>new Promise(resolve=>{release=resolve;})});
  const fetch=f.fetch();await turn();t.mock.timers.tick(5000);assert.equal((await fetch).status,503);assert.equal(f.actor.test_work.drained,false);
  f.setPhase("closed");const cut=f.actor.test_cut.capture();await turn();assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));
  release(beginBytes(1));await turn();assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==="finish"),["finish",1]);assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="cp"));
  await cut;assert.ok(f.actor.test_work.drained);assert.ok(f.calls.includes("sync"));
});
test("late CP response cancellation holds matching slot/SAME cut until actual cancel finally",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let releaseFetch,releaseCancel;const f=fixture({transport:()=>new Promise(resolve=>{releaseFetch=resolve;})});
  const fetch=f.fetch();await turn();t.mock.timers.tick(5000);await fetch;f.setPhase("closed");const cut=f.actor.test_cut.capture();await turn();assert.ok(!f.calls.includes("sync"));
  releaseFetch(new Response(new ReadableStream({cancel(){return new Promise(resolve=>{releaseCancel=resolve;});}}),{headers:{"cache-control":"no-store"}}));await turn();
  assert.equal(f.actor.test_work.drained,false);assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="finish"));releaseCancel();await cut;
  assert.ok(f.actor.test_work.drained);assert.ok(f.calls.findIndex(c=>Array.isArray(c)&&c[0]==="finish")<f.calls.indexOf("sync"));
});
test("held CP read/cancel and cut timeout stay UNKNOWN; abort is not settlement",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let releaseRead,releaseCancel;
  const body={getReader(){return {read:()=>new Promise(resolve=>{releaseRead=resolve;}),cancel:()=>new Promise(resolve=>{releaseCancel=resolve;}),releaseLock(){}};}};
  const f=fixture({transport:()=>({status:200,redirected:false,headers:new Headers({"cache-control":"no-store"}),body})});
  const fetch=f.fetch();await turn();t.mock.timers.tick(5000);await fetch;assert.equal(f.actor.test_work.drained,false);f.setPhase("closed");
  const cut=f.actor.test_cut.capture(),denied=assert.rejects(cut);await turn();t.mock.timers.tick(30000);await denied;assert.ok(!f.calls.includes("sync"));
  releaseRead({done:true});await turn();assert.equal(f.actor.test_work.drained,false);releaseCancel();await turn();assert.ok(f.actor.test_work.drained);
  await assert.rejects(f.actor.test_cut.capture());assert.ok(!f.calls.includes("bookmark"));
});
test("physical/phase/epoch/lifetime drift while CP held prevents accept but retains exact native cleanup",async()=>{
  for(const change of [f=>{f.state.id=f.id(A,"foreign");},f=>f.setPhase("closed"),f=>f.setEpoch(8),f=>f.setLifetime(1)]){
    let release;const f=fixture({transport:()=>new Promise(resolve=>{release=resolve;})});const fetch=f.fetch();await turn();change(f);
    release(new Response(JSON.stringify({admission:"AQID",expires_at:1}),{headers:{"cache-control":"no-store"}}));await fetch;
    assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="accept"));assert.deepEqual(f.calls.at(-1),["finish",1]);assert.ok(f.actor.test_work.drained);
  }
});
test("64 reads is a hard accumulation cap, not an EOF or positive ACK",async()=>{
  let reads=0,cancels=0;const body={getReader(){return {async read(){reads++;return {done:false,value:new Uint8Array()};},async cancel(){cancels++;},releaseLock(){}};}};
  const f=fixture({transport:()=>({status:200,redirected:false,headers:new Headers({"cache-control":"no-store"}),body})});await f.fetch();
  assert.equal(reads,64);assert.equal(cancels,1);assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="accept"));assert.deepEqual(f.calls.at(-1),["finish",1]);
});
test("caller abort returns503 without losing held native continuation/matching cleanup",async()=>{
  let release;const f=fixture({begin:()=>new Promise(resolve=>{release=resolve;})}),abort=new AbortController();
  const request=new Request(f.request(),{signal:abort.signal}),pending=f.actor.fetch(request);await turn();abort.abort();await pending;
  assert.equal(f.actor.test_work.drained,false);release(beginBytes(1));await turn();assert.ok(f.actor.test_work.drained);
  assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="cp"));assert.deepEqual(f.calls.at(-1),["finish",1]);
});
test("late cleanup retains original handle and cannot clear a synthetic successor slot",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let slot=0,next=0,releaseOld,releaseNew,count=0;
  const f=fixture({begin:async()=>{slot=++next;return beginBytes(slot);},accept:h=>assert.equal(slot,h),current:h=>assert.equal(slot,h),finish:h=>{if(slot===h)slot=0;},
    transport:()=>new Promise(resolve=>{if(++count===1)releaseOld=resolve;else releaseNew=resolve;})});
  const old=f.fetch();await turn();t.mock.timers.tick(5000);await old;assert.equal(slot,1);
  const successor=f.fetch();await turn();assert.equal(slot,2);
  const response=()=>new Response(JSON.stringify({admission:"AQID",expires_at:1}),{headers:{"cache-control":"no-store"}});
  releaseOld(response());await turn();assert.equal(slot,2);assert.equal(f.actor.test_work.drained,false);
  releaseNew(response());await successor;assert.equal(slot,0);assert.ok(f.actor.test_work.drained);
  assert.deepEqual(f.calls.filter(c=>Array.isArray(c)&&c[0]==="finish"),[["finish",1],["finish",2]]);
});
