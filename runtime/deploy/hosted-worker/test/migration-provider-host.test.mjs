// Synthetic native/storage ports qualify host shape checks and sequencing only;
// native run/action binding is covered by the Rust provider settlement tests.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
import {decode} from "../../../packages/sdk/src/cbor.ts";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts"; export {HostedCollection} from "./src/worker.ts"; export {migrationProviderInput} from "./src/migration-provider-result.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-private-ports",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));
  b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},args=>({contents:args.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
  b.onLoad({filter:/src\/(engine|worker)\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationProviderResult|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection,migrationProviderInput}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",owner="bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",run="cccccccc-cccc-4ccc-cccc-cccccccccccc";
const r1="11111111-1111-4111-8111-111111111111",r2="22222222-2222-4222-8222-222222222222";
const digest="ab".repeat(32),started="2026-10-12T08:00:00.000000Z";
const bytes=s=>Uint8Array.from(s.replaceAll("-","").match(/../g),h=>Number.parseInt(h,16));
const fence={collection_id:collection,state:"migrating",migration_id:run,started_at:started,retain_until:null,restored:[]};
const drain={collection_id:collection,state:"migrating",migration_id:run,head:42,started_at:started,retain_until:null,in_flight:0,unresolved:1,applied_unreceipted:0};
const account={account_id:owner,backend:"legacy",cohort:"lab-run-1",released:true,started:true,terminal_excluded:false,paused:false,hosted_collections:[collection],unsettled_collections:[],cut_over_collections:[]};
const replica=id=>({id,head:1,acknowledged_sequence:1,last_seen_at:started,token_expires_at:started});

test("each Connect/provider body maps to its fixed native mirror with sorted ids",()=>{
  assert.deepEqual(decode(migrationProviderInput({kind:"backup",hold_id:r1})),[0,bytes(r1)]);
  assert.deepEqual(decode(migrationProviderInput({kind:"fence",body:fence})),[2,bytes(collection),"migrating",bytes(run),started,null,[]]);
  assert.deepEqual(decode(migrationProviderInput({kind:"drain",body:drain})),[3,bytes(collection),"migrating",bytes(run),42,started,null,0,1,0]);
  assert.deepEqual(decode(migrationProviderInput({kind:"drain",body:{...drain,state:"active",migration_id:null,started_at:null}})),[3,bytes(collection),"active",null,42,null,null,0,1,0]);
  assert.deepEqual(decode(migrationProviderInput({kind:"account",body:account})),[1,bytes(owner),"legacy","lab-run-1",true,true,false,false,[bytes(collection)],[],[]]);
  assert.deepEqual(decode(migrationProviderInput({kind:"replicas",body:{replicas:[replica(r2),replica(r1)]}})),[4,[bytes(r1),bytes(r2)]]);
  assert.deepEqual(decode(migrationProviderInput({kind:"revoked",body:{revoked:[r2,r1]}})),[5,[bytes(r1),bytes(r2)]]);
  assert.deepEqual(decode(migrationProviderInput({kind:"cutover",body:{collection_id:collection,account_id:owner}})),[6,bytes(collection),bytes(owner)]);
});
test("extra, missing, non-canonical, nil, duplicate and unsafe fields refuse before native",()=>{
  const {replicas,...none}={replicas:[]};void replicas;
  for(const bad of [
    {kind:"backup",hold_id:run.toUpperCase()},{kind:"backup",hold_id:"00000000-0000-0000-0000-000000000000"},{kind:"backup",hold_id:`{${r1}}`},
    {kind:"fence",body:{...fence,extra:1}},{kind:"fence",body:(({restored,...f})=>f)(fence)},{kind:"fence",body:[fence]},
    {kind:"drain",body:{...drain,head:-1}},{kind:"drain",body:{...drain,head:2**53}},{kind:"drain",body:{...drain,in_flight:"0"}},{kind:"drain",body:{...drain,head:1.5}},
    {kind:"account",body:{...account,paused:"false"}},{kind:"account",body:{...account,hosted_collections:[collection,collection]}},
    {kind:"replicas",body:{replicas:[{id:r1}]}},{kind:"replicas",body:none},{kind:"revoked",body:{revoked:[r1,r1]}},
    {kind:"revoked",body:{revoked:Array.from({length:1001},(_,i)=>`${i.toString(16).padStart(8,"0")}-1111-4111-8111-111111111111`)}},
    {kind:"cutover",body:{collection_id:collection}},{kind:"route",body:{}},{kind:"backup"},
  ]) assert.throws(()=>migrationProviderInput(bad),/migration_provider_result_invalid/,JSON.stringify(bad).slice(0,80));
});
const ticket=(kind=11)=>Object.freeze({collection,driver:"driver",action:"action",sequence:3,kind,fingerprint:"cd".repeat(32)});
function engineFixture({length=32,pending=1,settlement=1,kind=11}={}){
  const e=Object.create(Engine.prototype),t=ticket(kind),calls=[],memory=new WebAssembly.Memory({initial:1});
  let seen;
  new Uint8Array(memory.buffer,64,Math.max(32,length)).fill(0xab);
  e.test_migrationLive=t;e.test_migrationTickets=new WeakMap([[t,7]]);
  e.ex={memory,alloc:n=>{calls.push(["alloc",n]);return 1024;},
    hd_migration_pending_current:h=>{calls.push(["pending",h]);return pending;},
    hd_migration_provider_result:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["provider",h,p,n]);return (64n<<32n)|BigInt(length);},
    hd_migration_settlement_current:h=>{calls.push(["settlement",h]);return settlement;},dealloc:(p,n)=>calls.push(["dealloc",p,n])};
  return {e,t,calls,memory,seen:()=>seen};
}
test("provider result passes ONLY the original handle and encoded body; digest wiped before free",()=>{
  const f=engineFixture();assert.equal(f.e.recordMigrationProviderResult(f.t,{kind:"fence",body:fence}),digest);
  const input=migrationProviderInput({kind:"fence",body:fence});
  assert.deepEqual(f.seen(),input);
  assert.deepEqual(f.calls,[["pending",7],["alloc",input.length],["provider",7,1024,input.length],["dealloc",64,32],["settlement",7]]);
  assert.ok(new Uint8Array(f.memory.buffer,64,32).every(v=>v===0));
});
test("wrong-kind, malformed, foreign/stale pending and empty/stale settlement produce no output",()=>{
  const wrong=engineFixture({kind:12});assert.throws(()=>wrong.e.recordMigrationProviderResult(wrong.t,{kind:"fence",body:fence}),/migration_settlement_refused/);
  assert.ok(!wrong.calls.some(c=>c[0]==="provider"));
  const bad=engineFixture();assert.throws(()=>bad.e.recordMigrationProviderResult(bad.t,{kind:"fence",body:{...fence,extra:1}}),/migration_provider_result_invalid/);
  assert.ok(!bad.calls.some(c=>c[0]==="provider"));
  const foreign=engineFixture();assert.throws(()=>foreign.e.recordMigrationProviderResult({...foreign.t},{kind:"fence",body:fence}),/migration_pending_refused/);assert.equal(foreign.calls.length,0);
  const stale=engineFixture({pending:0});assert.throws(()=>stale.e.recordMigrationProviderResult(stale.t,{kind:"fence",body:fence}),/migration_pending_refused/);assert.ok(!stale.calls.some(c=>c[0]==="provider"));
  for(const options of [{length:0},{length:31},{settlement:0}]){
    const f=engineFixture(options);assert.throws(()=>f.e.recordMigrationProviderResult(f.t,{kind:"fence",body:fence}),/migration_settlement_unknown/);
    assert.equal(f.calls.filter(c=>c[0]==="provider").length,1);
  }
});
function hostFixture(sync=async()=>{}){
  const h=Object.create(HostedCollection.prototype),t=ticket(),calls=[],physical=Object.freeze({collection,sequence:3});
  const result={kind:"fence",body:fence};
  const e={assertMigrationPendingCurrent:original=>{assert.equal(original,t);calls.push("pending-current");},
    recordMigrationProviderResult:(original,r)=>{assert.equal(original,t);assert.equal(r,result);calls.push("provider");return digest;},
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
  return {h,t,e,calls,result};
}
test("provider settlement returns the digest ONLY after sync, readback and physical confirmation",async()=>{
  const f=hostFixture();assert.equal(await f.h.test_commitMigrationProviderResult(f.t,f.result),digest);
  assert.deepEqual(f.calls,["pending-current","provider","physical-begin","physical-current","sync","settlement-current","physical-finish","settlement-confirmed","pending-finish","physical-close"]);
  assert.equal(f.h.commitMigrationProviderResult,undefined);
});
test("lost sync keeps the original pending occupied and never returns a digest",async()=>{
  const f=hostFixture(async()=>{throw Error("sync-lost");});
  await assert.rejects(f.h.test_commitMigrationProviderResult(f.t,f.result),/sync-lost/);
  assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
  const aborted=hostFixture(),controller=new AbortController();controller.abort();
  await assert.rejects(aborted.h.test_commitMigrationProviderResult(aborted.t,aborted.result,controller.signal),/migration_host_changed/);assert.deepEqual(aborted.calls,[]);
});
