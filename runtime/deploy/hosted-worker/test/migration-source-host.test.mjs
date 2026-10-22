// Synthetic native/storage ports qualify host shape checks and sequencing only;
// native run/action/page binding is covered by the Rust source settlement tests.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {build} from "esbuild";
import {decode} from "../../../packages/sdk/src/cbor.ts";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts"; export {HostedCollection} from "./src/worker.ts"; export {migrationSourceInput} from "./src/migration-source-result.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-private-ports",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));
  b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},args=>({contents:args.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
  b.onLoad({filter:/src\/(engine|worker)\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationSourceResult|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection,migrationSourceInput}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",hold="44444444-4444-4444-8444-444444444444",session="6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
const r1="11111111-1111-4111-8111-111111111111",r2="22222222-2222-4222-8222-222222222222";
const digest="ab".repeat(32),rev="sha256:"+"cd".repeat(32);
const bytes=s=>Uint8Array.from(s.replaceAll("-","").match(/../g),h=>Number.parseInt(h,16));
const hex=s=>Uint8Array.from(s.match(/../g),h=>Number.parseInt(h,16));
const request={collection,S0:42,expectedState:"migrating",backupHold:hold,retainUntil:"2027-01-10T00:00:00.000Z"};
const opened={kind:"opened",request,session};
const pageOf=(rows,{done=true,next=rows.at(-1)?.recordId??null}={})=>({rows,next,done,collection,S0:42,holdExpiresAt:"2026-10-13T00:00:00.000Z"});
const rec=(id,path="notes/a.md")=>({recordId:id,path,revision:rev,sequence:3,documentBytes:12,document:"hello world!",contentRef:null});
const records=(rows,options,after=null)=>({kind:"page",session,after,page:{table:"records",page:pageOf(rows,options)}});

test("open and each page table map to their fixed native mirrors",()=>{
  assert.deepEqual(decode(migrationSourceInput(opened)),[0,bytes(collection),"migrating",42,bytes(session),bytes(hold)]);
  assert.deepEqual(decode(migrationSourceInput(records([rec(r1),rec(r2,"b.md")],{done:false},r1.replace("1111-4","1110-4")))),
    [1,bytes(collection),42,bytes(session),"records",r1.replace("1111-4","1110-4"),[[bytes(r1),"notes/a.md",hex("cd".repeat(32)),12],[bytes(r2),"b.md",hex("cd".repeat(32)),12]],r2]);
  assert.deepEqual(decode(migrationSourceInput(records([rec(r1)]))).at(-1),null);
  const doc=new TextEncoder().encode("kind: task\n");
  const resources={kind:"page",session,after:null,page:{table:"resources",page:{...pageOf([]),rows:[{path:"mdbase.yaml",kind:"config",revision:"r7",document:doc}],next:"mdbase.yaml"}}};
  assert.deepEqual(decode(migrationSourceInput(resources))[6],[[null,"mdbase.yaml",Uint8Array.from(createHash("sha256").update(doc).digest()),doc.length]]);
  const files={kind:"page",session,after:null,page:{table:"files",page:{...pageOf([]),rows:[{fileId:r1,path:"a.png",contentDigest:rev,size:9,mediaType:null,mediaClass:"image",sequence:1,sourceRef:"x"}],next:r1}}};
  assert.deepEqual(decode(migrationSourceInput(files))[6],[[bytes(r1),"a.png",hex("cd".repeat(32)),9]]);
  assert.deepEqual(decode(migrationSourceInput(records([]))).slice(6),[[],null]);
});
test("a page over 64 rows or 48 KiB stops short and continues at its last admitted row",()=>{
  const id=n=>`10101010-1010-4010-8010-${n.toString(16).padStart(12,"0")}`;
  const many=Array.from({length:100},(_,i)=>rec(id(i+1),`r${i}.md`));
  const cut=decode(migrationSourceInput(records(many)));
  assert.equal(cut[6].length,64);assert.equal(cut[7],id(64));
  const long=Array.from({length:64},(_,i)=>rec(id(i+1),`${"d".repeat(200)}/${"e".repeat(200)}/${"f".repeat(400)}/${i}.md`));
  const input=migrationSourceInput(records(long));
  assert.ok(input.length<=48*1024);
  const page=decode(input);assert.ok(page[6].length<64);assert.equal(page[7],id(page[6].length));
});
test("malformed, non-canonical, unfinished-without-cursor and unsafe results refuse before native",()=>{
  for(const bad of [
    {...opened,session:session.toUpperCase()},{...opened,request:{...request,backupHold:"00000000-0000-0000-0000-000000000000"}},
    {...opened,request:{...request,expectedState:"migrated"}},{...opened,request:{...request,S0:-1}},{...opened,request:{...request,S0:2**53}},
    records([{...rec(r1),revision:"r1"}]),records([{...rec("abababab-1111-4111-8111-111111111111"),recordId:"ABABABAB-1111-4111-8111-111111111111"}]),records([{...rec(r1),path:""}]),
    records([{...rec(r1),path:"x".repeat(4097)}]),records([{...rec(r1),documentBytes:1.5}]),
    records([rec(r1)],{done:false,next:r2}),records([],{done:false,next:null}),
    {kind:"page",session,after:null,page:{table:"timers",page:pageOf([])}},
    {kind:"page",session,after:"",page:{table:"records",page:pageOf([])}},{kind:"cursor"},
  ]) assert.throws(()=>migrationSourceInput(bad),/migration_source_result_invalid/,JSON.stringify(bad).slice(0,80)+JSON.stringify(bad).slice(-120));
});
const ticket=(kind=3)=>Object.freeze({collection,driver:"driver",action:"action",sequence:9,kind,fingerprint:"cd".repeat(32)});
function engineFixture({length=32,pending=1,settlement=1,kind=3}={}){
  const e=Object.create(Engine.prototype),t=ticket(kind),calls=[],memory=new WebAssembly.Memory({initial:1});
  let seen;
  new Uint8Array(memory.buffer,64,Math.max(32,length)).fill(0xab);
  e.test_migrationLive=t;e.test_migrationTickets=new WeakMap([[t,7]]);
  e.ex={memory,alloc:n=>{calls.push(["alloc",n]);return 1024;},
    hd_migration_pending_current:h=>{calls.push(["pending",h]);return pending;},
    hd_migration_source_result:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["source",h,p,n]);return (64n<<32n)|BigInt(length);},
    hd_migration_settlement_current:h=>{calls.push(["settlement",h]);return settlement;},dealloc:(p,n)=>calls.push(["dealloc",p,n])};
  return {e,t,calls,memory,seen:()=>seen};
}
test("source result passes ONLY the original handle and encoded result; digest wiped before free",()=>{
  const result=records([rec(r1)]);
  const f=engineFixture();assert.equal(f.e.recordMigrationSourceResult(f.t,result),digest);
  const input=migrationSourceInput(result);
  assert.deepEqual(f.seen(),input);
  assert.deepEqual(f.calls,[["pending",7],["alloc",input.length],["source",7,1024,input.length],["dealloc",64,32],["settlement",7]]);
  assert.ok(new Uint8Array(f.memory.buffer,64,32).every(v=>v===0));
  const o=engineFixture({kind:2});assert.equal(o.e.recordMigrationSourceResult(o.t,opened),digest);
});
test("wrong-kind, malformed, foreign/stale pending and empty/stale settlement produce no output",()=>{
  const wrong=engineFixture({kind:2});assert.throws(()=>wrong.e.recordMigrationSourceResult(wrong.t,records([rec(r1)])),/migration_settlement_refused/);
  assert.ok(!wrong.calls.some(c=>c[0]==="source"));
  const bad=engineFixture();assert.throws(()=>bad.e.recordMigrationSourceResult(bad.t,records([{...rec(r1),revision:"x"}])),/migration_source_result_invalid/);
  assert.ok(!bad.calls.some(c=>c[0]==="source"));
  const foreign=engineFixture();assert.throws(()=>foreign.e.recordMigrationSourceResult({...foreign.t},records([rec(r1)])),/migration_pending_refused/);assert.equal(foreign.calls.length,0);
  const stale=engineFixture({pending:0});assert.throws(()=>stale.e.recordMigrationSourceResult(stale.t,records([rec(r1)])),/migration_pending_refused/);assert.ok(!stale.calls.some(c=>c[0]==="source"));
  for(const options of [{length:0},{length:31},{settlement:0}]){
    const f=engineFixture(options);assert.throws(()=>f.e.recordMigrationSourceResult(f.t,records([rec(r1)])),/migration_settlement_unknown/);
    assert.equal(f.calls.filter(c=>c[0]==="source").length,1);
  }
});
function hostFixture(sync=async()=>{}){
  const h=Object.create(HostedCollection.prototype),t=ticket(),calls=[],physical=Object.freeze({collection,sequence:9});
  const result=records([rec(r1)]);
  const e={assertMigrationPendingCurrent:original=>{assert.equal(original,t);calls.push("pending-current");},
    recordMigrationSourceResult:(original,r)=>{assert.equal(original,t);assert.equal(r,result);calls.push("source");return digest;},
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
  return {h,t,e,calls,result};
}
test("source settlement returns the digest ONLY after sync, readback and physical confirmation",async()=>{
  const f=hostFixture();assert.equal(await f.h.test_commitMigrationSourceResult(f.t,f.result),digest);
  assert.deepEqual(f.calls,["pending-current","source","physical-begin","physical-current","sync","settlement-current","physical-finish","settlement-confirmed","pending-finish","physical-close"]);
  assert.equal(f.h.commitMigrationSourceResult,undefined);
});
test("lost sync keeps the original pending occupied and never returns a digest",async()=>{
  const f=hostFixture(async()=>{throw Error("sync-lost");});
  await assert.rejects(f.h.test_commitMigrationSourceResult(f.t,f.result),/sync-lost/);
  assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
});
