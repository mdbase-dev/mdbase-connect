// Actual required wrapper/entry; native CLOSED lifecycle ports + R2/cut mocked.
// Private test projection ONLY, not an operator endpoint or native auth proof.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
const built=await build({entryPoints:[new URL("../../cloudflare-do/src/pitr-worker.mjs",import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"native-closed-ports",setup(b){
  b.onLoad({filter:/cloudflare-do\/src\/pitr-worker\.mjs$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(state|work|restriction|cut|stopResources)\b/g,"test_$1"),loader:"js"}));
  b.onResolve({filter:/build\/worker\/shim\.mjs$/},()=>({path:"native",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},()=>({contents:`export class LogCollection {
    constructor(state,env){if(env.LOGSVC_PITR_REQUIRED!=="1")throw Error("ordinary construction");this.nativeState=state;
      state.setWebSocketAutoResponse(undefined);for(const ws of state.getWebSockets())ws.close(1008,"PITR closed");}
    fetch(){throw Error("ordinary native fetch must never execute");}
    async alarm(){await this.nativeState.storage.deleteAlarm();return new Response(null);}
    async webSocketMessage(ws,message){await this.nativeState.holdWs();ws.close(1008,"PITR closed");}
    async webSocketClose(ws,code,reason,clean){await this.nativeState.holdWs();}
    async webSocketError(ws,error){await this.nativeState.holdWs();ws.close(1008,"PITR closed");}
  }` }));
}}]});
const {default:worker,LogCollection}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd",NIL="00000000-0000-0000-0000-000000000000";
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({collection=A,space="log",envChange={},get,holdAlarm,holdWs,holdSync}={}){
  const calls=[],objectText=(c,s)=>s==="log"?c===A?"01".repeat(32):c===D?"02".repeat(32):c===NIL?"03".repeat(32):"ff".repeat(32):c===A?"04".repeat(32):"05".repeat(32);
  const id=(c,s="log",text=objectText(c,s))=>({toString:()=>text,equals(other){return other.c===c&&other.s===s;},c,s});
  const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
    ...[A,D].map(c=>({kind:"log",collection:c,namespace:"01".repeat(16),object:objectText(c,"log")})),
    {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:objectText(NIL,"log")},
    ...[A,D].map(c=>({kind:"hosted",collection:c,namespace:"02".repeat(16),object:objectText(c,"hosted")}))]};
  let phase="seed",epoch=7,change={},alarms=0;
  const issuedAt=Date.now()-1000,expiresAt=Date.now()+600000;
  const object=()=>{const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch,phase,issuedAt,expiresAt,...change}));
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};};
  const state={id:id(collection,space),waitUntil(p){calls.push("waitUntil");void p.catch(()=>{});},setWebSocketAutoResponse(){calls.push("disable-auto");},getWebSockets(){return [];},
    async holdWs(){calls.push("ws");if(holdWs)await holdWs();},storage:{get sql(){assert.fail("SQL before admission");},async get(){assert.fail("restored authority");},
      async deleteAlarm(){calls.push("deleteAlarm");if(holdAlarm)await holdAlarm(++alarms);},async sync(){calls.push("sync");if(holdSync)await holdSync();},
      async getCurrentBookmark(){calls.push("bookmark");return "synthetic-cut";},async onNextSessionRestoreBookmark(value){calls.push(["stage",value]);return "synthetic-future-undo";}},
    abort(message,options){calls.push(["abort",message,options]);}};
  const env={PITR_BINDING:JSON.stringify(binding),PITR_MINIMUM_EPOCH:"1",PITR_PHASE:{async get(key){calls.push(["phase",key]);return get?get(object):object();}},
    LOG:{idFromName:c=>id(c),get(target){calls.push("stub");assert.equal(target.c,collection);return {fetch:req=>actor.fetch(req)};}},...envChange};
  for(const key of ["LOGSVC_ROOT_KEYS","LOGSVC_TOKEN_ISSUERS","LOGSVC_URL_SECRET","INSECURE_TEST_KEYS","LOGSVC_CORS_ORIGINS","OBJECTS","METRICS"])
    Object.defineProperty(env,key,{get(){assert.fail("secret/binding "+key);}});
  const actor=new LogCollection(state,env);
  const fetch=(subject=collection,method="POST",path="/v1/rpc")=>actor.fetch(new Request(`https://fixture.test${path}?c=${subject}`,{method}));
  return {actor,state,env,calls,fetch,binding,id,object,setPhase:p=>{phase=p;},setEpoch:e=>{epoch=e;},setChange:c=>{change=c;}};
}
const gets=f=>f.calls.filter(c=>Array.isArray(c)&&c[0]==="phase").length;
test("actual required existing RPC routes A/D/nil metadata only and remains503",async()=>{
  for(const c of [A,D,NIL]){
    const f=fixture({collection:c});assert.ok(f.actor.test_restriction);assert.ok(f.actor.test_cut);
    const request=new Request(`https://fixture.test/v1/rpc?c=${c}`,{method:"POST",body:new ReadableStream({pull(){assert.fail("body read");}},{highWaterMark:0}),duplex:"half"});
    const r=await worker.fetch(request,f.env);assert.equal(r.status,503);assert.equal(r.headers.get("cache-control"),"no-store");assert.equal(gets(f),1);assert.ok(f.actor.test_work.drained);
    assert.throws(()=>f.actor.test_work.begin());assert.equal((await f.fetch()).status,503);assert.equal(gets(f),2);
    assert.equal((await f.fetch(c,"GET")).status,503);assert.equal((await f.fetch(c,"POST","/other")).status,503);assert.equal(gets(f),2);
  }
});
test("partial/malformed config never borrows ordinary actor, phase or namespace",async()=>{
  for(const envChange of [{PITR_BINDING:undefined},{PITR_BINDING:"{}"},{PITR_MINIMUM_EPOCH:"0"},{PITR_MINIMUM_EPOCH:1},{PITR_PHASE:undefined}]){
    const f=fixture({envChange});assert.equal(f.actor.test_cut,null);assert.equal((await f.fetch()).status,503);assert.equal(gets(f),0);
    assert.equal((await worker.fetch(new Request(`https://fixture.test/v1/rpc?c=${A}`,{method:"POST"}),f.env)).status,503);assert.ok(!f.calls.includes("stub"));
  }
});
test("foreign/hosted namespaces and wrong configured object cannot borrow ID text",async()=>{
  for(const collection of [A,D,NIL])for(const space of ["hosted","foreign"]){
    const f=fixture({collection,space});assert.equal(f.actor.test_cut,null);assert.equal((await f.fetch()).status,503);assert.equal(gets(f),0);
  }
  const f=fixture();f.state.id=f.id(A,"foreign",f.state.id.toString());await assert.rejects(f.actor.test_restriction.assertSeedCurrent(A,new AbortController().signal));assert.equal(gets(f),0);
});
test("fresh phase rejects phase/epoch/lifetime/binding drift, never grants nil serving",async()=>{
  const f=fixture({collection:NIL});await f.actor.test_restriction.assertSeedCurrent(NIL,new AbortController().signal);
  for(const phase of ["closed","mutate","authority","readback",null]){f.setPhase(phase);await assert.rejects(f.actor.test_restriction.assertSeedCurrent(NIL,new AbortController().signal));}
  f.setPhase("seed");for(const change of [{epoch:0},{expiresAt:0},{binding:{...f.binding,codeConfigSha256:"fe".repeat(32)}}]){
    f.setChange(change);await assert.rejects(f.actor.test_restriction.assertSeedCurrent(NIL,new AbortController().signal));}
  assert.equal((await f.fetch()).status,503);assert.ok(f.actor.test_work.drained);
});
test("held actual RPC fetch finally precedes SAME cut sync/bookmark; busy and pending block new phase",async()=>{
  let release,reads=0;const f=fixture({collection:NIL,get:object=>++reads===1?new Promise(resolve=>{release=()=>resolve(object());}):Promise.resolve(object())});
  const fetching=f.fetch();await turn();assert.equal(f.actor.test_work.drained,false);f.setPhase("closed");const cut=f.actor.test_cut.capture();await turn();
  assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));const before=gets(f);await f.fetch();assert.equal(gets(f),before);
  release();assert.equal((await fetching).status,503);const receipt=await cut;assert.equal(receipt.member.kind,"registry");assert.equal(receipt.bookmark,"synthetic-cut");
  const undo=await f.actor.test_cut.stageRestore(receipt);assert.equal(undo.bookmark,"synthetic-future-undo");const after=gets(f);await f.fetch();assert.equal(gets(f),after);
  assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="abort"));await assert.rejects(f.actor.test_cut.restart(undo));assert.deepEqual(f.calls.at(-1),["abort","LAB PITR closed restart",{retryAlarm:false}]);
});
test("held native CLOSED alarm actual finally must settle before SAME cut",async()=>{
  let release;const f=fixture({holdAlarm:n=>n===1?new Promise(resolve=>{release=resolve;}):Promise.resolve()});
  const alarm=f.actor.alarm();await turn();f.setPhase("closed");const cut=f.actor.test_cut.capture();await turn();assert.equal(f.actor.test_work.drained,false);assert.ok(!f.calls.includes("sync"));
  release();await alarm;assert.equal((await cut).bookmark,"synthetic-cut");assert.ok(f.actor.test_work.drained);
});
test("selected actual WS cleanup promise finally shares work/cut, not close/abort settlement",async()=>{
  for(const method of ["webSocketMessage","webSocketClose","webSocketError"]){
    let release;const f=fixture({holdWs:()=>new Promise(resolve=>{release=resolve;})}),ws={close(){f.calls.push("socket-close");}};
    const cleanup=f.actor[method](ws,new Uint8Array([0]),"synthetic",true);await turn();f.setPhase("closed");const cut=f.actor.test_cut.capture();await turn();
    assert.equal(f.actor.test_work.drained,false);assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));release();await cleanup;await cut;assert.ok(f.actor.test_work.drained);
  }
});
test("physical drift after held storage await sticks UNKNOWN and refuses new callbacks",async()=>{
  let release;const f=fixture({holdSync:()=>new Promise(resolve=>{release=resolve;})});f.setPhase("closed");
  const cut=f.actor.test_cut.capture(),denied=assert.rejects(cut);await turn();f.state.id=f.id(A,"foreign");release();await denied;
  assert.ok(!f.calls.includes("bookmark"));const before=gets(f);await f.fetch();assert.equal(gets(f),before);await assert.rejects(f.actor.test_cut.capture());
});
test("closed64-ticket cap prevents excess RPC phase IO; ordinary begin never reopens",async()=>{
  const f=fixture(),tickets=Array.from({length:64},()=>f.actor.test_work.beginClosed());assert.throws(()=>f.actor.test_work.beginClosed());
  await f.fetch();assert.equal(gets(f),0);for(const t of tickets){t.finish();t.finish();}assert.ok(f.actor.test_work.drained);assert.throws(()=>f.actor.test_work.begin());
});
test("late read/cancel retain actual continuations after request and cut deadline",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let releaseRead,releaseCancel,reads=0;
  const f=fixture({get:object=>++reads===1?{size:1,body:{getReader(){return {read(){return new Promise(resolve=>{releaseRead=resolve;});},
    cancel(){return new Promise(resolve=>{releaseCancel=resolve;});},releaseLock(){}};}}}:object()});
  const pending=f.fetch();await turn();t.mock.timers.tick(5000);assert.equal((await pending).status,503);assert.equal(f.actor.test_work.drained,false);
  f.setPhase("closed");const cut=f.actor.test_cut.capture(),denied=assert.rejects(cut);await turn();t.mock.timers.tick(30000);await denied;
  assert.ok(!f.calls.includes("sync"));releaseRead({done:true});await turn();assert.equal(f.actor.test_work.drained,false);releaseCancel();await turn();
  assert.ok(f.actor.test_work.drained);assert.ok(!f.calls.includes("bookmark"));await assert.rejects(f.actor.test_cut.capture());
});
test("late cut storage cannot settle UNKNOWN until its actual callback finally",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let release;
  const f=fixture({holdSync:()=>new Promise(resolve=>{release=resolve;})});f.setPhase("closed");const cut=f.actor.test_cut.capture(),denied=assert.rejects(cut);await turn();
  assert.equal(f.actor.test_work.drained,false);t.mock.timers.tick(30000);await denied;assert.equal(f.actor.test_work.drained,false);release();await turn();
  assert.ok(f.actor.test_work.drained);assert.ok(!f.calls.includes("bookmark"));await assert.rejects(f.actor.test_cut.capture());
});
test("late get/cancel after caller deadline and cut UNKNOWN count until actual finally",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let releaseGet,releaseCancel,reads=0;
  const f=fixture({get:object=>++reads===1?new Promise(resolve=>{releaseGet=resolve;}):Promise.resolve(object())});
  const fetch=f.fetch();await turn();t.mock.timers.tick(5000);assert.equal((await fetch).status,503);assert.equal(f.actor.test_work.drained,false);
  f.setPhase("closed");const cut=f.actor.test_cut.capture(),denied=assert.rejects(cut);await turn();t.mock.timers.tick(30000);await denied;assert.ok(!f.calls.includes("sync"));
  releaseGet({size:1,body:new ReadableStream({cancel(){return new Promise(resolve=>{releaseCancel=resolve;});}})});await turn();assert.equal(f.actor.test_work.drained,false);
  releaseCancel();await turn();assert.ok(f.actor.test_work.drained);assert.ok(!f.calls.includes("bookmark"));await assert.rejects(f.actor.test_cut.capture());
});
