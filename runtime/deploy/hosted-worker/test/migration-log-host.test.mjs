// Synthetic native/storage ports qualify host shape checks and sequencing only;
// the log path's sealing, sending and settlement from the Engine's own log
// evidence are covered by the Rust log-path tests over the actual Engine.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
import {encode} from "../../../packages/sdk/src/cbor.ts";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts"; export {HostedCollection} from "./src/worker.ts"; export * from "./src/migration-log-output.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-private-ports",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));
  b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},args=>({contents:args.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
  b.onLoad({filter:/src\/(engine|worker)\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationLogResult|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection,LOG_KIND,isLogKind,decodeLogAppendSent}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const digest="ab".repeat(32);

test("log kinds are exactly the native log actions",()=>{
  assert.deepEqual(Object.values(LOG_KIND).sort((a,b)=>a-b),[6,7,8,9,15,16,18]);
  for(const k of [0,4,5,10,11,12,13,14,17,19,20]) assert.equal(isLogKind(k),false,String(k));
});
test("sent output decodes only an exact item hash and position",()=>{
  const item=new Uint8Array(32).fill(7);
  assert.deepEqual(decodeLogAppendSent(encode([item,12])),{item:"07".repeat(32),seq:12});
  for(const bad of [encode([item.slice(1),12]),encode([item,0]),encode([item,-1]),encode([item,2**53]),encode([item,"12"]),encode([item]),encode([item,12,1]),encode(new Map([["item",item]]))])
    assert.throws(()=>decodeLogAppendSent(bad),/migration_log_output_invalid/);
});

const ticket=kind=>Object.freeze({collection,driver:"driver",action:"action",sequence:9,kind,fingerprint:"cd".repeat(32)});
function engineFixture({kind=LOG_KIND.appendBase,length=32,settlement=1,output}={}){
  const e=Object.create(Engine.prototype),t=ticket(kind),calls=[],memory=new WebAssembly.Memory({initial:1});
  const out=output??new Uint8Array(length).fill(0xab);
  new Uint8Array(memory.buffer,64,out.length).set(out);
  const give=()=>out.length===0?0n:(64n<<32n)|BigInt(out.length);
  e.test_migrationLive=t;e.test_migrationTickets=new WeakMap([[t,7]]);
  e.ex={memory,alloc:n=>{calls.push(["alloc",n]);return 1024;},
    hd_migration_pending_current:h=>{calls.push(["pending",h]);return 1;},
    hd_migration_log_append:h=>{calls.push(["append",h]);return give();},
    hd_migration_log_result:h=>{calls.push(["result",h]);return give();},
    hd_migration_settlement_current:h=>{calls.push(["settlement",h]);return settlement;},dealloc:(p,n)=>calls.push(["dealloc",p,n])};
  return {e,t,calls,memory};
}
test("append passes ONLY the original handle and settles nothing",()=>{
  const sent=encode([new Uint8Array(32).fill(3),5]);
  const f=engineFixture({output:sent});
  assert.deepEqual(f.e.migrationLogAppend(f.t),{item:"03".repeat(32),seq:5});
  assert.deepEqual(f.calls,[["pending",7],["append",7],["dealloc",64,sent.length]]);
  for(const kind of [LOG_KIND.findBase,LOG_KIND.appendCutover,LOG_KIND.rebuild,4]){
    const wrong=engineFixture({kind,output:sent});
    assert.throws(()=>wrong.e.migrationLogAppend(wrong.t),/migration_settlement_refused/);
    assert.ok(!wrong.calls.some(c=>c[0]==="append"));
  }
  const refused=engineFixture({length:0});
  assert.throws(()=>refused.e.migrationLogAppend(refused.t),/migration_log_refused/);
});
test("result settles every log kind only with readback and refuses other kinds before native",()=>{
  for(const kind of Object.values(LOG_KIND)){
    const r=engineFixture({kind});assert.equal(r.e.recordMigrationLogResult(r.t),digest);
    assert.deepEqual(r.calls.map(c=>c[0]),["pending","result","dealloc","settlement"]);
  }
  for(const options of [{length:0},{length:31},{settlement:0}]){
    const f=engineFixture(options);assert.throws(()=>f.e.recordMigrationLogResult(f.t),/migration_settlement_unknown/);
  }
  for(const kind of [3,4,5,14,19]){
    const other=engineFixture({kind});assert.throws(()=>other.e.recordMigrationLogResult(other.t),/migration_settlement_refused/);
    assert.ok(!other.calls.some(c=>c[0]==="result"));
  }
});

function hostFixture(sync=async()=>{}){
  const h=Object.create(HostedCollection.prototype),t=ticket(LOG_KIND.rebuild),calls=[],physical=Object.freeze({collection,sequence:9});
  const e={assertMigrationPendingCurrent:original=>{assert.equal(original,t);calls.push("pending-current");},
    recordMigrationLogResult:original=>{assert.equal(original,t);calls.push("log");return digest;},
    recordMigrationGen0Result:()=>assert.fail("gen0 result substituted"),
    recordMigrationSourceResult:()=>assert.fail("source result substituted"),
    recordMigrationProviderResult:()=>assert.fail("provider result substituted"),
    recordMigrationTargetCreated:()=>assert.fail("positive outcome substituted"),
    recordMigrationKeyingWait:()=>assert.fail("negative outcome substituted"),
    beginMigrationPhysical:original=>{assert.equal(original,t);calls.push("physical-begin");return physical;},
    assertMigrationPhysicalCurrent:p=>{assert.equal(p,physical);calls.push("physical-current");},
    assertMigrationSettlementCurrent:original=>{assert.equal(original,t);calls.push("settlement-current");},
    finishMigrationPhysical:p=>{assert.equal(p,physical);calls.push("physical-finish");},
    assertMigrationSettlementConfirmed:original=>{assert.equal(original,t);calls.push("settlement-confirmed");},
    finishMigrationPending:original=>{assert.equal(original,t);calls.push("pending-finish");},
    closeMigrationPhysical:p=>{assert.equal(p,physical);calls.push("physical-close");}};
  const id={equals:other=>other===id};
  h.engine=e;h.collection=collection;h.logGen=7;Object.defineProperty(h,"alarms",{value:{current:true}});h.env={COLLECTIONS:{idFromName:c=>{assert.equal(c,collection);return id;}}};
  h.ctx={id,storage:{sync:async()=>{calls.push("sync");await sync();}}};
  h.test_migrationConfirmed=new WeakMap([[t,{engine:e,generation:7}]]);
  return {h,t,calls};
}
test("log settlement returns the digest ONLY after sync, readback and physical confirmation",async()=>{
  const f=hostFixture();assert.equal(await f.h.test_commitMigrationLogResult(f.t),digest);
  assert.deepEqual(f.calls,["pending-current","log","physical-begin","physical-current","sync","settlement-current","physical-finish","settlement-confirmed","pending-finish","physical-close"]);
  assert.equal(f.h.commitMigrationLogResult,undefined);
});
test("lost sync keeps the original pending occupied and never returns a digest",async()=>{
  const f=hostFixture(async()=>{throw Error("sync-lost");});
  await assert.rejects(f.h.test_commitMigrationLogResult(f.t),/sync-lost/);
  assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
});
test("a host change after sync never returns a digest",async()=>{
  const f=hostFixture(async()=>{f.h.logGen=8;});
  await assert.rejects(f.h.test_commitMigrationLogResult(f.t),/migration_host_changed/);
  assert.ok(!f.calls.includes("pending-finish"));
});
