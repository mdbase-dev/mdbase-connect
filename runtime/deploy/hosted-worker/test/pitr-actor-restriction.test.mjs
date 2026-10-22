// Actual required constructor/activation/cut composition; platform/R2/cut ports
// mocked here. The separate workerd test qualifies native namespace equality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd";
const NIL="00000000-0000-0000-0000-000000000000";
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const bundled=await build({entryPoints:[new URL("../src/pitr-worker.ts",import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{
  name:"required-actor-ports",setup(b){
    b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"state",namespace:"platform"}));
    b.onLoad({filter:/.*/,namespace:"platform"},()=>({contents:"export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }"}));
    b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"wasm"}));
    b.onLoad({filter:/.*/,namespace:"wasm"},()=>({contents:"export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));"}));
  }
}]});
const {HostedCollection}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
function fixture({collection=A,namespace="hosted",change={},envChange={},get,holdSync,holdAlarm}={}) {
  const calls=[];let alarmDeletes=0;
  const id=(name,space="hosted",text=name===A?"04".repeat(32):name===D?"05".repeat(32):"ff".repeat(32))=>({name,space,toString:()=>text,
    equals(other){calls.push("id.equals");return other.name===name&&other.space===space;}});
  const binding={run:"gate4-pitr-lab-20261009-01",active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
    ...[A,D].map((collection,i)=>({kind:"log",collection,namespace:"01".repeat(16),object:`0${i+1}`.repeat(32)})),
    {kind:"registry",collection:NIL,namespace:"01".repeat(16),object:"03".repeat(32)},
    ...[A,D].map((collection,i)=>({kind:"hosted",collection,namespace:"02".repeat(16),object:`0${i+4}`.repeat(32)}))]};
  let phase="seed",epoch=7,phaseChange={};
  const issuedAt=Date.now()-1000,expiresAt=Date.now()+600000;
  const object=()=>{const bytes=new TextEncoder().encode(JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch,phase,issuedAt,expiresAt,...phaseChange}));
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};};
  const ctx={id:id(collection,namespace),waitUntil(promise){calls.push("waitUntil");void promise.catch(()=>{});},storage:{sql:{exec(){assert.fail("SQL access before admission");}},
    async get(){assert.fail("restored label used for admission");},async put(){assert.fail("storage authority write");},async setAlarm(){assert.fail("reschedule");},
    async deleteAlarm(){calls.push("deleteAlarm");if(holdAlarm)await holdAlarm(++alarmDeletes);},async sync(){calls.push("sync");if(holdSync)await holdSync();},
    async getCurrentBookmark(){calls.push("bookmark");return "synthetic-bookmark";},
    async onNextSessionRestoreBookmark(bookmark){calls.push(["stage",bookmark]);return "synthetic-future-undo";}},
    abort(message,options){calls.push(["abort",message,options]);},getWebSockets(){return [];},setWebSocketAutoResponse(){calls.push("disable-auto-response");}};
  const env={LAB:"1",SERVICE_KIND:"hosted",PITR_BINDING:JSON.stringify({...binding,...change}),PITR_MINIMUM_EPOCH:"1",
    COLLECTIONS:{idFromName(name){calls.push(["idFromName",name]);return id(name);}},
    PITR_PHASE:{async get(key){calls.push(["phase-get",key]);return get?get(object):object();}},...envChange};
  for(const key of ["LAB_HOSTED_CONFIG","HOSTED_SERVICE_TOKEN","HOSTED_KMS_PROVIDER","HOSTED_KMS_KEY_ID","CP_INBOUND_TOKEN","AWS_SECRET_ACCESS_KEY"])
    Object.defineProperty(env,key,{get(){assert.fail(`key/custody setting ${key}`);}});
  const actor=new HostedCollection(ctx,env);
  const fetch=(subject=collection,method="POST",path="/v1/hosted/activate")=>actor.fetch(new Request(`https://synthetic.test${path}?collection=${subject}`,{method}));
  return {actor,ctx,calls,fetch,binding,object,id,setPhase(v){phase=v;},setEpoch(v){epoch=v;},setPhaseChange(v){phaseChange=v;}};
}
const phaseReads=f=>f.calls.filter(c=>Array.isArray(c)&&c[0]==="phase-get").length;

test("actual required A/D activation is physically restricted but never opens keys/serving",async()=>{
  for(const collection of [A,D]){
    const f=fixture({collection});assert.ok(f.actor.pitrRestriction);assert.ok(f.actor.pitrCut);
    assert.equal(f.actor.engine,null);assert.equal(f.actor.production,null);
    const response=await f.fetch();assert.equal(response.status,503);assert.equal(response.headers.get("cache-control"),"no-store");
    assert.equal(phaseReads(f),1);assert.equal(f.actor.pitrWork.drained,true);assert.equal(f.actor.engine,null);
    await assert.rejects(f.actor.ready(collection),/pitr_actor_closed/);
    for(const [subject,method,path] of [[D===collection?A:D,"POST","/v1/hosted/activate"],[collection,"GET","/v1/hosted/activate"],[collection,"POST","/status"]])
      assert.equal((await f.fetch(subject,method,path)).status,503);
    assert.equal(phaseReads(f),1);
  }
});

test("missing/partial/malformed profile never constructs a cut or reads phase",async()=>{
  for(const envChange of [{PITR_BINDING:undefined},{PITR_BINDING:"{}"},{PITR_BINDING:""},{PITR_MINIMUM_EPOCH:"0"},{PITR_PHASE:undefined},{SERVICE_KIND:"escrow"},{LAB:"0"}]){
    const f=fixture({envChange});assert.equal(f.actor.pitrCut,null);assert.equal((await f.fetch()).status,503);assert.equal(phaseReads(f),0);
  }
});

test("foreign namespace, nil, nonmember and wrong configured object cannot borrow matching strings",async()=>{
  for(const options of [{namespace:"foreign"},{collection:NIL},{collection:"33333333-3333-4333-a333-333333333333"},
    {change:{members:fixture().binding.members.map(m=>m.kind==="hosted"&&m.collection===A?{...m,object:"fa".repeat(32)}:m)}}]){
    const f=fixture(options);assert.equal(f.actor.pitrCut,null);assert.equal((await f.fetch()).status,503);assert.equal(phaseReads(f),0);
  }
});

test("fresh external phase is uncached; changed/missing/expired/foreign records stay closed",async()=>{
  const f=fixture();await f.actor.pitrRestriction.assertSeedCurrent(A,new AbortController().signal);
  for(const phase of ["closed","authority","mutate","readback",null]){
    f.setPhase(phase);await assert.rejects(f.actor.pitrRestriction.assertSeedCurrent(A,new AbortController().signal));
  }
  f.setPhase("seed");
  for(const change of [{expiresAt:0},{epoch:0},{binding:{...f.binding,run:"other"}},
    {binding:{...f.binding,codeConfigSha256:"fe".repeat(32)}},
    {binding:{...f.binding,members:f.binding.members.map(m=>({...m,namespace:"fe".repeat(16)}))}}]){
    f.setPhaseChange(change);await assert.rejects(f.actor.pitrRestriction.assertSeedCurrent(A,new AbortController().signal));
  }
  assert.equal(f.actor.pitrWork.drained,true);
});

test("physical drift across actual activation await cannot become a completed restriction",async()=>{
  let release;const f=fixture({get:object=>new Promise(resolve=>{release=()=>resolve(object());})});
  const pending=f.fetch();await turn();assert.equal(f.actor.pitrWork.drained,false);
  f.ctx.id=f.id(A,"foreign");release();assert.equal((await pending).status,503);
  assert.equal(f.actor.pitrWork.drained,true);assert.equal(f.actor.engine,null);
  await assert.rejects(f.actor.pitrCut.capture(),/pitr_cut_unknown/);assert.ok(!f.calls.includes("bookmark"));
});

test("SAME actor cut waits for a held actual closed callback finally, not abort",async()=>{
  let release,reads=0;const f=fixture({get:object=>++reads===1?new Promise(resolve=>{release=()=>resolve(object());}):Promise.resolve(object())});
  const fetching=f.fetch();await turn();assert.equal(f.actor.pitrWork.drained,false);
  f.setPhase("closed");let captured=false;const capture=f.actor.pitrCut.capture().then(r=>{captured=true;return r;});await turn();
  assert.equal(captured,false);assert.equal(f.actor.pitrWork.drained,false);assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));
  const readsBefore=phaseReads(f);assert.equal((await f.fetch()).status,503);assert.equal(phaseReads(f),readsBefore,"new callbacks cannot cross cut/drain");
  release();assert.equal((await fetching).status,503);const receipt=await capture;
  assert.equal(f.actor.pitrWork.drained,true);assert.equal(receipt.member.collection,A);assert.equal(receipt.bookmark,"synthetic-bookmark");
  const undo=await f.actor.pitrCut.stageRestore(receipt);assert.equal(undo.bookmark,"synthetic-future-undo");
  const readsAfterStage=phaseReads(f);assert.equal((await f.fetch()).status,503);assert.equal(phaseReads(f),readsAfterStage,"pending restore remains restricted");
  assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="abort"));
  await assert.rejects(f.actor.pitrCut.restart(undo),/pitr_cut_unknown/);
  assert.deepEqual(f.calls.at(-1),["abort","LAB PITR closed restart",{retryAlarm:false}]);
});

test("SAME cut waits for an executing CLOSED alarm deletion's actual finally",async()=>{
  let release;const f=fixture({holdAlarm:n=>n===1?new Promise(resolve=>{release=resolve;}):Promise.resolve()});
  const alarm=f.actor.alarm();await turn();assert.equal(f.actor.pitrWork.drained,false);f.setPhase("closed");
  const capture=f.actor.pitrCut.capture();await turn();assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));
  release();await alarm;assert.equal((await capture).bookmark,"synthetic-bookmark");assert.equal(f.actor.pitrWork.drained,true);
});

test("native physical context is rechecked after a held cut-storage await; UNKNOWN is sticky",async()=>{
  let release;const f=fixture({holdSync:()=>new Promise(resolve=>{release=resolve;})});f.setPhase("closed");
  const capturing=f.actor.pitrCut.capture(),refused=assert.rejects(capturing,/pitr_cut_unknown/);await turn();
  assert.ok(f.calls.includes("sync"));f.ctx.id=f.id(A,"foreign");release();await refused;
  assert.ok(!f.calls.includes("bookmark"));const count=f.calls.length;await assert.rejects(f.actor.pitrCut.capture());assert.equal(f.calls.length,count);
});

test("CLOSED callback capacity never reopens ordinary work or starts excess I/O",async()=>{
  const f=fixture();assert.throws(()=>f.actor.pitrWork.begin());
  const tickets=Array.from({length:64},()=>f.actor.pitrWork.beginClosed());
  assert.throws(()=>f.actor.pitrWork.beginClosed());assert.equal((await f.fetch()).status,503);assert.equal(phaseReads(f),0);
  assert.equal(f.actor.pitrWork.drained,false);for(const ticket of tickets){ticket.finish();ticket.finish();}
  assert.equal(f.actor.pitrWork.drained,true);assert.throws(()=>f.actor.pitrWork.begin());
});

test("cut deadline cannot settle a late storage callback or produce a receipt",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let release;
  const f=fixture({holdSync:()=>new Promise(resolve=>{release=resolve;})});f.setPhase("closed");
  const capture=f.actor.pitrCut.capture(),unknown=assert.rejects(capture,/pitr_cut_unknown/);await turn();
  assert.ok(f.calls.includes("sync"));assert.equal(f.actor.pitrWork.drained,false);t.mock.timers.tick(30000);await unknown;
  assert.equal(f.actor.pitrWork.drained,false);release();await turn();assert.equal(f.actor.pitrWork.drained,true);
  assert.ok(!f.calls.includes("bookmark"));await assert.rejects(f.actor.pitrCut.capture());
});

test("deadline returns503 but late get AND late body cancellation remain tracked to actual finally",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let releaseGet,releaseCancel,reads=0;const f=fixture({get:object=>++reads===1?new Promise(resolve=>{releaseGet=resolve;}):Promise.resolve(object())});
  const fetching=f.fetch();await turn();t.mock.timers.tick(5000);assert.equal((await fetching).status,503);
  assert.equal(f.actor.pitrWork.drained,false,"get continuation is still physically outstanding");
  f.setPhase("closed");const capturing=f.actor.pitrCut.capture(),unknown=assert.rejects(capturing,/pitr_cut_unknown/);await turn();
  assert.ok(!f.calls.includes("sync"));t.mock.timers.tick(30000);await unknown;
  releaseGet({size:1,body:new ReadableStream({cancel(){return new Promise(resolve=>{releaseCancel=resolve;});}})});await turn();
  assert.equal(f.actor.pitrWork.drained,false,"late cancellation is not settlement");releaseCancel();await turn();
  assert.equal(f.actor.pitrWork.drained,true);assert.ok(!f.calls.includes("bookmark"));await assert.rejects(f.actor.pitrCut.capture());
});
