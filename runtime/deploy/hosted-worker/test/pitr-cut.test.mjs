// Port-level mechanics only: mocked storage/bookmarks/reset, never local PITR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PitrCut, PitrWork } from "../src/pitr-cut.ts";
import { PITR_RUN } from "../src/pitr-phase.ts";
const A="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",D="dddddddd-dddd-4ddd-addd-dddddddddddd";
const binding={run:PITR_RUN,active:A,deleted:D,codeConfigSha256:"ab".repeat(32),members:[
  ...[A,D].map((collection,i)=>({kind:"log",collection,namespace:"01".repeat(16),object:`0${i+1}`.repeat(32)})),
  {kind:"registry",collection:"00000000-0000-0000-0000-000000000000",namespace:"01".repeat(16),object:"03".repeat(32)},
  ...[A,D].map((collection,i)=>({kind:"hosted",collection,namespace:"02".repeat(16),object:`0${i+4}`.repeat(32)})),
]};
const member=binding.members[3];
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
  const calls=[];const work=new PitrWork();let phase="closed",epoch=7,time=1000,reads=0,expires=5000;
  const state={id:{toString:()=>member.object},storage:{
    async deleteAlarm(){calls.push("deleteAlarm");if(options.fail==="alarm")throw Error("private provider detail");},
    async sync(){calls.push("sync");if(options.fail==="sync")throw Error("private provider detail");},
    async getCurrentBookmark(){calls.push("bookmark");if(options.fail==="bookmark")throw Error("private provider detail");return options.bookmark??"synthetic-bookmark";},
    async onNextSessionRestoreBookmark(bookmark){calls.push(["stage",bookmark]);if(options.fail==="stage")throw Error("private provider detail");if(options.afterStage)options.afterStage();return options.undo??"synthetic-undo";}
  },abort(message,options){calls.push(["abort",message,options]);}};
  const get=async()=>{
    reads++;calls.push("phase");if(options.onRead)options.onRead(reads);
    if(phase===null)return null;
    const text=JSON.stringify({schema:"mdbn-lab-pitr-phase/1",binding,epoch,phase,issuedAt:500,expiresAt:expires});
    const bytes=new TextEncoder().encode(text);
    return {size:bytes.length,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};
  };
  const cut=new PitrCut(state,{binding,member,minimumEpoch:1},get,work,()=>{calls.push("stopResources");if(options.fail==="resources")throw Error("private socket detail");},()=>time);
  return {cut,work,state,calls,setPhase(v){phase=v;},setEpoch(v){epoch=v;},setTime(v){time=v;},setExpiry(v){expires=v;}};
}

test("RAM close fences every outstanding ticket before drain, never pretends abort is settlement",async()=>{
  const work=new PitrWork(),a=work.begin(),b=work.begin();a.check();
  work.close();assert.equal(a.signal.aborted,true);assert.equal(b.signal.aborted,true);
  assert.throws(()=>a.check(),/pitr_cut_unknown/);assert.throws(()=>work.begin(),/pitr_cut_unknown/);
  let drained=false;const wait=work.drain().then(()=>{drained=true;});await turn();assert.equal(drained,false);
  a.finish();a.finish();await turn();assert.equal(drained,false);b.finish();await wait;assert.equal(work.drained,true);
  assert.throws(()=>a.check());
});

test("owned work capacity is finite",()=>{
  const w=new PitrWork(),tickets=Array.from({length:64},()=>w.begin());
  assert.throws(()=>w.begin());w.close();for(const t of tickets)t.finish();assert.equal(w.drained,true);
});

test("capture cancels resources and alarm but waits for executing work and sync before bookmark",async()=>{
  const f=fixture(),ticket=f.work.begin();let done=false;
  const capturing=f.cut.capture().then(r=>{done=true;return r;});await turn();
  assert.equal(ticket.signal.aborted,true);assert.equal(done,false);assert.deepEqual(f.calls,["stopResources","phase","deleteAlarm"]);
  assert.throws(()=>ticket.check());ticket.finish();const r=await capturing;
  assert.deepEqual(f.calls,["stopResources","phase","deleteAlarm","sync","phase","bookmark","phase"]);
  assert.deepEqual(r,{schema:"mdbn-lab-pitr-cut/1",run:PITR_RUN,codeConfigSha256:binding.codeConfigSha256,member,epoch:7,bookmark:"synthetic-bookmark"});
});

test("null/expired/valid-but-open phases never reach provider storage",async()=>{
  for(const phase of [null,"seed","mutate","authority","readback"]){
    const f=fixture();f.setPhase(phase);await assert.rejects(f.cut.capture(),/pitr_cut_unknown/);
    assert.deepEqual(f.calls,["stopResources","phase"]);assert.equal(f.work.drained,true);
  }
  const f=fixture();f.setTime(5000);await assert.rejects(f.cut.capture());assert.deepEqual(f.calls,["stopResources","phase"]);
});

test("epoch or phase drift across storage awaits withholds the cut",async()=>{
  for(const change of [f=>f.setEpoch(8),f=>f.setPhase("seed"),f=>f.setExpiry(6000)]){
    let f;f=fixture({onRead(n){if(n===2)change(f);}});
    await assert.rejects(f.cut.capture(),/pitr_cut_unknown/);assert.ok(!f.calls.includes("bookmark"));
  }
});

test("actual object/member/config mismatch closes before any provider access",()=>{
  const f=fixture();
  for(const config of [
    {binding,member:{...member,object:"ff".repeat(32)},minimumEpoch:1},
    {binding:{...binding,run:"other"},member,minimumEpoch:1},
    {binding,member,minimumEpoch:0},
  ])assert.throws(()=>new PitrCut(f.state,config,async()=>null,f.work,()=>{}),/pitr_cut_unknown/);
  assert.deepEqual(f.calls,[]);
});

test("resource/storage errors remain sticky UNKNOWN without arbitrary diagnostic or blind retry",async()=>{
  for(const fail of ["resources","alarm","sync","bookmark"]){
    const f=fixture({fail});await assert.rejects(f.cut.capture(),{message:"pitr_cut_unknown"});
    const count=f.calls.length;await assert.rejects(f.cut.capture(),/pitr_cut_unknown/);assert.equal(f.calls.length,count);
  }
});

test("whole operation timeout prevents a late callback from advancing to bookmark",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(),ticket=f.work.begin();
  const pending=f.cut.capture(),refused=assert.rejects(pending,/pitr_cut_unknown/);await turn();t.mock.timers.tick(30000);await refused;
  ticket.finish();await turn();assert.ok(!f.calls.includes("sync"));assert.ok(!f.calls.includes("bookmark"));
  await assert.rejects(f.cut.capture(),/pitr_cut_unknown/);
});

test("stage returns a future undo anchor before a separate no-alarm-retry restart",async()=>{
  const f=fixture(),cut=await f.cut.capture();const undo=await f.cut.stageRestore(cut);
  assert.equal(undo.bookmark,"synthetic-undo");assert.ok(f.calls.some(c=>Array.isArray(c)&&c[0]==="stage"&&c[1]===cut.bookmark));
  assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="abort"));
  await assert.rejects(f.cut.restart(),/pitr_cut_unknown/);
  await assert.rejects(f.cut.restart(undo),/pitr_cut_unknown/,"fake abort return cannot produce success ACK");
  assert.deepEqual(f.calls.at(-1),["abort","LAB PITR closed restart",{retryAlarm:false}]);
});

test("wrong run/member/config/epoch/bookmark receipts cannot stage",async()=>{
  const base=await fixture().cut.capture();
  for(const r of [{...base,run:"other"},{...base,codeConfigSha256:"ff".repeat(32)},
    {...base,member:{...member,namespace:"ff".repeat(16)}},{...base,epoch:0},{...base,epoch:8},
    {...base,bookmark:"x".repeat(513)},{...base,extra:true}]){
    const f=fixture();await assert.rejects(f.cut.stageRestore(r),/pitr_cut_unknown/);
    assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="stage"));
  }
});

test("receipt mutation and unknown-after-arm leave serving fenced and prohibit retry/reset",async()=>{
  let f;f=fixture({afterStage(){f.setEpoch(8);}});
  const r=await f.cut.capture();await assert.rejects(f.cut.stageRestore(r));assert.equal(f.work.drained,true);
  const count=f.calls.length;await assert.rejects(f.cut.stageRestore(r));await assert.rejects(f.cut.restart());assert.equal(f.calls.length,count);
  const g=fixture();const original=await g.cut.capture();const undo=await g.cut.stageRestore(original);undo.bookmark="modified";
  await assert.rejects(g.cut.restart(undo));assert.ok(!g.calls.some(c=>Array.isArray(c)&&c[0]==="abort"));
});

test("invalid provider bookmarks/undo values never yield a receipt",async()=>{
  await assert.rejects(fixture({bookmark:""}).cut.capture());
  const f=fixture({undo:""}),r=await f.cut.capture();await assert.rejects(f.cut.stageRestore(r));
  assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==="abort"));
});
