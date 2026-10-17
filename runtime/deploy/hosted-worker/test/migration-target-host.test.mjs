// Synthetic native/storage ports qualify host sequencing only, not authentic
// caller admission, native positive target completion or physical durability.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts"; export {HostedCollection} from "./src/worker.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-private-ports",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));
  b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},args=>({contents:args.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
  b.onLoad({filter:/src\/(engine|worker)\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationTargetCreated|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",digest="ab".repeat(32);
const ticket=()=>Object.freeze({collection,driver:"driver",action:"action",sequence:1,kind:0,fingerprint:"cd".repeat(32)});
function engineFixture({length=32,pending=1,settlement=1}={}){
  const e=Object.create(Engine.prototype),t=ticket(),calls=[],memory=new WebAssembly.Memory({initial:1});
  new Uint8Array(memory.buffer,64,Math.max(32,length)).fill(0xab);
  e.test_migrationLive=t;e.test_migrationTickets=new WeakMap([[t,7]]);
  e.ex={memory,hd_migration_pending_current:h=>{calls.push(["pending",h]);return pending;},
    hd_migration_target_complete:(...args)=>{calls.push(["target",...args]);return (64n<<32n)|BigInt(length);},
    hd_migration_settlement_current:h=>{calls.push(["settlement",h]);return settlement;},dealloc:(p,n)=>calls.push(["dealloc",p,n])};
  return {e,t,calls,memory};
}
test("native target completion receives ONLY the original handle and bounded digest is wiped before free",()=>{
  const f=engineFixture();assert.equal(f.e.recordMigrationTargetCreated(f.t),digest);
  assert.deepEqual(f.calls,[["pending",7],["target",7],["dealloc",64,32],["settlement",7]]);
  assert.ok(new Uint8Array(f.memory.buffer,64,32).every(v=>v===0));
});
test("foreign/stale pending and empty/wrong-sized/stale settlement cannot produce output",()=>{
  const foreign=engineFixture();assert.throws(()=>foreign.e.recordMigrationTargetCreated({...foreign.t}),/migration_pending_refused/);assert.equal(foreign.calls.length,0);
  const stale=engineFixture({pending:0});assert.throws(()=>stale.e.recordMigrationTargetCreated(stale.t),/migration_pending_refused/);assert.ok(!stale.calls.some(c=>c[0]==="target"));
  for(const options of [{length:0},{length:31},{length:33},{settlement:0}]){
    const f=engineFixture(options);assert.throws(()=>f.e.recordMigrationTargetCreated(f.t),/migration_settlement_unknown/);
    assert.deepEqual(f.calls.find(c=>c[0]==="target"),["target",7]);
  }
});
function hostFixture(sync=async()=>{},fault=""){
  const h=Object.create(HostedCollection.prototype),t=ticket(),calls=[],physical=Object.freeze({collection,sequence:1});
  const e={assertMigrationPendingCurrent:original=>{assert.equal(original,t);calls.push("pending-current");},
    recordMigrationTargetCreated:original=>{assert.equal(original,t);calls.push("target");return digest;},
    recordMigrationKeyingWait:()=>assert.fail("negative outcome substituted"),
    beginMigrationPhysical:original=>{assert.equal(original,t);calls.push("physical-begin");return physical;},
    assertMigrationPhysicalCurrent:p=>{assert.equal(p,physical);calls.push("physical-current");},
    assertMigrationSettlementCurrent:original=>{assert.equal(original,t);calls.push("settlement-current");if(fault==="current")throw Error("current-lost");},
    finishMigrationPhysical:p=>{assert.equal(p,physical);calls.push("physical-finish");if(fault==="finish")throw Error("ack-lost");},
    assertMigrationSettlementConfirmed:original=>{assert.equal(original,t);calls.push("settlement-confirmed");},
    finishMigrationPending:original=>{assert.equal(original,t);calls.push("pending-finish");},
    closeMigrationPhysical:p=>{assert.equal(p,physical);calls.push("physical-close");}};
  const id={equals:other=>other===id};
  h.engine=e;h.collection=collection;h.logGen=7;Object.defineProperty(h,"alarms",{value:{current:true}});h.env={COLLECTIONS:{idFromName:c=>{assert.equal(c,collection);return id;}}};
  h.ctx={id,storage:{sync:async()=>{calls.push("sync");await sync();}}};
  h.test_migrationConfirmed=new WeakMap([[t,{engine:e,generation:7}]]);
  return {h,t,e,calls};
}
test("target settlement returns original digest ONLY after same-context sync/readback/physical confirmation",async()=>{
  const f=hostFixture();assert.equal(await f.h.test_commitMigrationTargetCreated(f.t),digest);
  assert.deepEqual(f.calls,["pending-current","target","physical-begin","physical-current","sync","settlement-current","physical-finish","settlement-confirmed","pending-finish","physical-close"]);
  assert.equal(f.h.test_migrationConfirmed.has(f.t),false);
  assert.equal(f.h.commitMigrationTargetCreated,undefined);assert.equal(f.h.commitMigrationSettlement,undefined);
});
test("abort and foreign confirmation refuse BEFORE native target effect",async()=>{
  const aborted=hostFixture(),controller=new AbortController();controller.abort();
  await assert.rejects(aborted.h.test_commitMigrationTargetCreated(aborted.t,controller.signal),/migration_host_changed/);assert.deepEqual(aborted.calls,[]);
  const foreign=hostFixture();await assert.rejects(foreign.h.test_commitMigrationTargetCreated({...foreign.t}),/migration_host_changed/);assert.deepEqual(foreign.calls,[]);
});
test("post-await abort/context drift retains original occupied confirmation and closes ONLY original physical slot",async()=>{
  for(const drift of [f=>{f.h.logGen++;},f=>{f.h.engine={...f.e};},f=>{f.h.collection="foreign";},f=>{f.h.alarms.current=false;}]){
    let release;const f=hostFixture(()=>new Promise(resolve=>{release=resolve;}));const pending=f.h.test_commitMigrationTargetCreated(f.t);
    drift(f);release();await assert.rejects(pending,/migration_host_changed/);
    assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.equal(f.calls.filter(c=>c==="target").length,1);
    assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
  }
  let release;const f=hostFixture(()=>new Promise(resolve=>{release=resolve;})),controller=new AbortController();
  const pending=f.h.test_commitMigrationTargetCreated(f.t,controller.signal);controller.abort();release();
  await assert.rejects(pending,/migration_host_changed/);assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.ok(!f.calls.includes("pending-finish"));
});
test("lost sync, settlement readback or physical ACK never clears original pending or returns a digest",async()=>{
  for(const [sync,fault] of [[async()=>{throw Error("sync-lost");},""],[async()=>{},"current"],[async()=>{},"finish"]]){
    const f=hostFixture(sync,fault);await assert.rejects(f.h.test_commitMigrationTargetCreated(f.t),/lost/);
    assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.equal(f.calls.filter(c=>c==="target").length,1);
    assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
  }
});
