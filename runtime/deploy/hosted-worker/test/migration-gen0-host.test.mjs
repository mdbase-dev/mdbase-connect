// Synthetic native/storage ports qualify host shape checks and sequencing only;
// native byte verification, custody and settlement are covered by the Rust
// generation-0 tests over the actual Engine.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
import {decode,encode} from "../../../packages/sdk/src/cbor.ts";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts"; export {HostedCollection} from "./src/worker.ts"; export * from "./src/migration-gen0-input.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-private-ports",setup(b){
  b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));
  b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
  b.onLoad({filter:/.*/,namespace:"fake"},args=>({contents:args.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
  b.onLoad({filter:/src\/(engine|worker)\.ts$/},args=>({contents:readFileSync(args.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationGen0Result|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection,migrationGen0FileChunkInput,migrationGen0FileInput,migrationGen0WindowInput,migrationGen0ResultInput,decodeGen0Placements,decodeGen0Sealed}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const collection="aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",session="6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
const r1="11111111-1111-4111-8111-111111111111",f1="99999999-9999-4999-8999-999999999999";
const digest="ab".repeat(32),rev="sha256:"+"cd".repeat(32);
const bytes=s=>Uint8Array.from(s.replaceAll("-","").match(/../g),h=>Number.parseInt(h,16));
const source={collection,S0:42,session};
const gif=Uint8Array.from([71,73,70,56,57,97,1,0,1,0]);
const fileRow=(size=gif.length)=>({fileId:f1,path:"assets/a.gif",contentDigest:rev,size,mediaType:"image/gif",mediaClass:"image",sequence:1,sourceRef:"x"});
const rec=(document="# A\n")=>({recordId:r1,path:"notes/a.md",revision:rev,sequence:3,documentBytes:4,document,contentRef:null});
const res=(text="name: one\n")=>({path:"mdbase.yaml",kind:"config",revision:"r1",document:new TextEncoder().encode(text)});

test("file, window and result inputs map to their fixed native mirrors",()=>{
  assert.deepEqual(decode(migrationGen0FileInput({source,file:fileRow(),bytes:gif})),[bytes(collection),42,bytes(session),bytes(f1),gif]);
  assert.deepEqual(decode(migrationGen0WindowInput({source,rows:[{resource:res()}]})),[bytes(collection),42,bytes(session),[["mdbase.yaml","name: one\n"]]]);
  assert.deepEqual(decode(migrationGen0WindowInput({source,rows:[{record:rec()}]}))[3],[[bytes(r1),"# A\n"]]);
  assert.deepEqual(decode(migrationGen0ResultInput({collection,present:[true,false]})),[bytes(collection),[true,false]]);
});
test("oversized, mismatched-size, by-reference, non-UTF-8 and malformed inputs refuse before native",()=>{
  const big=new Uint8Array((1<<20)+1);
  for(const bad of [
    ()=>migrationGen0FileInput({source,file:fileRow(big.length),bytes:big}),
    ()=>migrationGen0FileInput({source,file:fileRow(gif.length+1),bytes:gif}),
    ()=>migrationGen0FileInput({source:{...source,session:session.toUpperCase()},file:fileRow(),bytes:gif}),
    ()=>migrationGen0FileInput({source:{...source,S0:2**53},file:fileRow(),bytes:gif}),
    ()=>migrationGen0FileInput({source,file:{...fileRow(),fileId:"00000000-0000-0000-0000-000000000000"},bytes:gif}),
    ()=>migrationGen0WindowInput({source,rows:[{record:{...rec(),document:null,contentRef:"ref"}}]}),
    ()=>migrationGen0WindowInput({source,rows:[{resource:{...res(),document:Uint8Array.from([0xff,0xfe])}}]}),
    ()=>migrationGen0WindowInput({source,rows:[{resource:{...res(),path:""}}]}),
    ()=>migrationGen0WindowInput({source,rows:Array.from({length:129},()=>({record:rec()}))}),
    ()=>migrationGen0WindowInput({source,rows:[{record:rec("x".repeat((1<<20)+1))}]}),
    ()=>migrationGen0WindowInput({source,rows:[{timer:{}}]}),
    ()=>migrationGen0ResultInput({collection,present:[1]}),
    ()=>migrationGen0ResultInput({collection,present:Array(5000).fill(true)}),
  ]) assert.throws(bad,/migration_gen0_input_invalid/,bad.toString());
});
test("old window boundary and 1 MiB cap preserve byte-identical singleton records",()=>{
  for(const size of [64*1024-1,64*1024,64*1024+1,93655,1<<20]) {
    const document="\ufeff"+"x".repeat(size-3);
    const input=migrationGen0WindowInput({source,rows:[{record:rec(document)}]});
    assert.equal(decode(input)[3][0][1],document);
  }
  assert.throws(()=>migrationGen0WindowInput({source,rows:[{record:rec("x".repeat(1<<20))},{record:rec()}]}),/migration_gen0_input_invalid/);
});

test("sealed output decodes only exact addresses, kinds and bytes",()=>{
  const a=new Uint8Array(32).fill(1),b=new Uint8Array(32).fill(2);
  assert.deepEqual(decodeGen0Sealed(encode([[[a,18,Uint8Array.from([5])]],[a,b]])),
    {objects:[{address:"01".repeat(32),kind:18,bytes:Uint8Array.from([5])}],verify:["01".repeat(32),"02".repeat(32)]});
  for(const bad of [encode([[[a.slice(1),18,a]],[]]),encode([[[a,"chunk",a]],[]]),encode([[],[b.slice(2)]]),encode([[]])])
    assert.throws(()=>decodeGen0Sealed(bad),/migration_gen0_input_invalid/);
});

const ticket=(kind=4)=>Object.freeze({collection,driver:"driver",action:"action",sequence:9,kind,fingerprint:"cd".repeat(32)});
function engineFixture({kind=4,length=32,settlement=1,output}={}){
  const e=Object.create(Engine.prototype),t=ticket(kind),calls=[],memory=new WebAssembly.Memory({initial:1});
  let seen;
  const out=output??new Uint8Array(length).fill(0xab);
  new Uint8Array(memory.buffer,64,out.length).set(out);
  const give=()=>out.length===0?0n:(64n<<32n)|BigInt(out.length);
  e.test_migrationLive=t;e.test_migrationTickets=new WeakMap([[t,7]]);
  e.ex={memory,alloc:n=>{calls.push(["alloc",n]);return 1024;},
    hd_migration_pending_current:h=>{calls.push(["pending",h]);return 1;},
    hd_migration_gen0_refusal:()=>0,
    hd_migration_gen0_placements:h=>{calls.push(["placements",h]);return give();},
    hd_migration_gen0_file_chunk:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["file-chunk",h]);return give();},
    hd_migration_gen0_file:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["file",h]);return give();},
    hd_migration_gen0_window:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["window",h]);return give();},
    hd_migration_gen0_finish:h=>{calls.push(["finish",h]);return give();},
    hd_migration_gen0_result:(h,p,n)=>{seen=new Uint8Array(memory.buffer,p,n).slice();calls.push(["result",h]);return give();},
    hd_migration_settlement_current:h=>{calls.push(["settlement",h]);return settlement;},dealloc:(p,n)=>calls.push(["dealloc",p,n])};
  return {e,t,calls,memory,seen:()=>seen};
}
const sealed=encode([[[new Uint8Array(32).fill(3),18,Uint8Array.from([9,9])]],[new Uint8Array(32).fill(3)]]);
test("sealing passes ONLY the original handle and encoded input, and settles nothing",()=>{
  const f=engineFixture({output:sealed});
  const out=f.e.migrationGen0File(f.t,{source,file:fileRow(),bytes:gif});
  assert.deepEqual(f.seen(),migrationGen0FileInput({source,file:fileRow(),bytes:gif}));
  assert.deepEqual(out.verify,["03".repeat(32)]);
  assert.ok(!f.calls.some(c=>c[0]==="settlement"));
  // The plaintext input is wiped after the call and the output before free.
  assert.ok(new Uint8Array(f.memory.buffer,64,sealed.length).every(v=>v===0));
  const w=engineFixture({output:sealed});w.e.migrationGen0Window(w.t,{source,rows:[{resource:res()}]});
  assert.deepEqual(w.calls.map(c=>c[0]),["pending","alloc","window","dealloc"]);
  const fin=engineFixture({kind:5,output:sealed});fin.e.migrationGen0Finish(fin.t);
  assert.deepEqual(fin.calls.map(c=>c[0]),["pending","finish","dealloc"]);
});
test("wrong kind and native refusal produce no output; result settles only with readback",()=>{
  const wrong=engineFixture({kind:5});
  assert.throws(()=>wrong.e.migrationGen0Window(wrong.t,{source,rows:[]}),/migration_settlement_refused/);
  const early=engineFixture({kind:4});assert.throws(()=>early.e.migrationGen0Finish(early.t),/migration_settlement_refused/);
  assert.ok(!early.calls.some(c=>c[0]==="finish"));
  const refused=engineFixture({length:0});
  assert.throws(()=>refused.e.migrationGen0Window(refused.t,{source,rows:[]}),/migration_gen0_refused/);
  const r=engineFixture({kind:5});assert.equal(r.e.recordMigrationGen0Result(r.t,{collection,present:[true]}),digest);
  assert.deepEqual(r.calls.map(c=>c[0]),["pending","alloc","result","dealloc","settlement"]);
  for(const options of [{length:0},{length:31},{settlement:0}]){
    const f=engineFixture(options);assert.throws(()=>f.e.recordMigrationGen0Result(f.t,{collection,present:[true]}),/migration_settlement_unknown/);
  }
  const other=engineFixture({kind:3});assert.throws(()=>other.e.recordMigrationGen0Result(other.t,{collection,present:[]}),/migration_settlement_refused/);
});

test("stream chunks use the versioned sequential mirror with fixed per-chunk bounds",()=>{
  const full=new Uint8Array(8<<20), total=full.length+gif.length;
  assert.deepEqual(decode(migrationGen0FileChunkInput({source,file:fileRow(total),offset:0,bytes:full})),
    [bytes(collection),42,bytes(session),bytes(f1),0,full]);
  assert.deepEqual(decode(migrationGen0FileChunkInput({source,file:fileRow(total),offset:full.length,bytes:gif})),
    [bytes(collection),42,bytes(session),bytes(f1),full.length,gif]);
  assert.deepEqual(decode(migrationGen0FileChunkInput({source,file:fileRow(0),offset:0,bytes:new Uint8Array()}))[5],new Uint8Array());
  for(const input of [
    {source,file:fileRow(total),offset:0,bytes:gif},
    {source,file:fileRow(total),offset:full.length+1,bytes:gif},
    {source,file:fileRow(total),offset:-1,bytes:full},
    {source,file:fileRow((1<<30)+1),offset:0,bytes:full},
    {source,file:fileRow(total),offset:total+1,bytes:new Uint8Array()},
  ]) assert.throws(()=>migrationGen0FileChunkInput(input),/migration_gen0_input_invalid/);
});

test("native-selected placement output is metadata, with strict row shape",()=>{
  const hash=new Uint8Array(32).fill(1);
  const output=encode([[[0,"mdbase.yaml","mdbase.yaml",10,hash],[1,r1,"a.md",4,hash],[2,f1,"a.gif",9,hash]],false]);
  const placements=decodeGen0Placements(output);
  assert.equal(placements.done,false);assert.equal(placements.rows.length,3);
  assert.deepEqual(placements.rows[1],{kind:1,key:r1,path:"a.md",size:4,hash:"01".repeat(32)});
  const f=engineFixture({output});assert.deepEqual(f.e.migrationGen0Placements(f.t),placements);
  assert.deepEqual(f.calls.map(c=>c[0]),["pending","placements","dealloc"]);
  for(const bad of [encode([[],1]),encode([[[3,r1,"a.md",4,hash]],true]),encode([[[1,"bad","a.md",4,hash]],true]),
    encode([[[1,r1,"a.md",-1,hash]],true]),encode([[[1,r1,"a.md",4,hash.slice(1)]],true]),
    encode([Array.from({length:129},()=>[0,"mdbase.yaml","mdbase.yaml",10,hash]),true])]) {
    assert.throws(()=>decodeGen0Placements(bad),/migration_gen0_input_invalid/);
  }
});

test("stream sealing only uses the original handle, wipes input, and cannot settle",()=>{
  const f=engineFixture({output:sealed});
  f.e.migrationGen0FileChunk(f.t,{source,file:fileRow(),offset:0,bytes:gif});
  assert.deepEqual(f.seen(),migrationGen0FileChunkInput({source,file:fileRow(),offset:0,bytes:gif}));
  assert.deepEqual(f.calls.map(c=>c[0]),["pending","alloc","file-chunk","dealloc"]);
  const wrong=engineFixture({kind:5});
  assert.throws(()=>wrong.e.migrationGen0FileChunk(wrong.t,{source,file:fileRow(),offset:0,bytes:gif}),/migration_settlement_refused/);
  assert.throws(()=>wrong.e.migrationGen0Placements(wrong.t),/migration_settlement_refused/);
  const refused=engineFixture({length:0});
  assert.throws(()=>refused.e.migrationGen0Placements(refused.t),/migration_gen0_refused/);
  assert.throws(()=>refused.e.migrationGen0FileChunk(refused.t,{source,file:fileRow(),offset:0,bytes:gif}),/migration_gen0_refused/);
});

function hostFixture(sync=async()=>{}){
  const h=Object.create(HostedCollection.prototype),t=ticket(),calls=[],physical=Object.freeze({collection,sequence:9});
  const result={collection,present:[true,true]};
  const e={assertMigrationPendingCurrent:original=>{assert.equal(original,t);calls.push("pending-current");},
    recordMigrationGen0Result:(original,r)=>{assert.equal(original,t);assert.equal(r,result);calls.push("gen0");return digest;},
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
  return {h,t,calls,result};
}
test("gen0 settlement returns the digest ONLY after sync, readback and physical confirmation",async()=>{
  const f=hostFixture();assert.equal(await f.h.test_commitMigrationGen0Result(f.t,f.result),digest);
  assert.deepEqual(f.calls,["pending-current","gen0","physical-begin","physical-current","sync","settlement-current","physical-finish","settlement-confirmed","pending-finish","physical-close"]);
  assert.equal(f.h.commitMigrationGen0Result,undefined);
});
test("lost sync keeps the original pending occupied and never returns a digest",async()=>{
  const f=hostFixture(async()=>{throw Error("sync-lost");});
  await assert.rejects(f.h.test_commitMigrationGen0Result(f.t,f.result),/sync-lost/);
  assert.equal(f.h.test_migrationConfirmed.has(f.t),true);assert.ok(!f.calls.includes("pending-finish"));assert.equal(f.calls.at(-1),"physical-close");
});
