// Synthetic ports: shape/currentness/physical sequencing only, no authority.
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {build} from "esbuild";
const bundled=await build({stdin:{contents:'export {Engine} from "./src/engine.ts";export {HostedCollection} from "./src/worker.ts";',resolveDir:new URL("../",import.meta.url).pathname,loader:"ts"},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"synthetic-ports",setup(b){
 b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"platform",namespace:"fake"}));b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake"}));
 b.onLoad({filter:/.*/,namespace:"fake"},a=>({contents:a.path==="platform"?'export class DurableObject {}':'export default new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));'}));
 b.onLoad({filter:/src\/(engine|worker)\.ts$/},a=>({contents:readFileSync(a.path,"utf8").replace(/#(migrationLive|migrationTickets|migrationConfirmed|commitMigrationSettlement)\b/g,"test_$1"),loader:"ts"}));
}}]});
const {Engine,HostedCollection}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const id=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,"0")}`;
const body={collection_id:id(1),binding:{owner_account_id:id(2),provider_migration_id:id(3),authority_epoch:17,fixed_head:40,driver_id:id(4),action_id:id(5),replica_ids:[]},restored_ids:[],recorded_at:"2026-10-12T22:00:00Z"};
const ticket=Object.freeze({collection:id(1),driver:id(4),action:id(5),sequence:3,kind:21,fingerprint:"cd".repeat(32)});
const digest="ab".repeat(32);
test("full receipt reaches only its original live native handle, never generic provider Ok",()=>{
 const e=Object.create(Engine.prototype),memory=new WebAssembly.Memory({initial:1});let calls=0;
 new Uint8Array(memory.buffer,64,32).fill(0xab);
 e.test_migrationLive=ticket;e.test_migrationTickets=new WeakMap([[ticket,7]]);
 e.ex={memory,alloc:()=>1024,dealloc:()=>{},hd_migration_pending_current:()=>1,hd_migration_rollback_result:()=>{calls++;return(64n<<32n)|32n;},hd_migration_settlement_current:()=>1};
 assert.throws(()=>e.recordMigrationRollbackResult({...ticket},body),/migration_pending_refused/);assert.equal(calls,0);
 assert.throws(()=>e.recordMigrationRollbackResult(ticket,{state:"active"}),/migration_rollback_input_invalid/);assert.equal(calls,0);
 assert.equal(e.recordMigrationRollbackResult(ticket,body),digest);assert.equal(calls,1);
 assert.ok(new Uint8Array(memory.buffer,64,32).every(v=>v===0));
});
function host(sync=async()=>{}){
 const h=Object.create(HostedCollection.prototype),calls=[],physical={},actor={equals:o=>o===actor};
 const e={assertMigrationPendingCurrent:()=>calls.push("pending"),recordMigrationRollbackResult:(t,b)=>{assert.equal(t,ticket);assert.equal(b,body);calls.push("original-receipt");return digest;},beginMigrationPhysical:()=>{calls.push("begin");return physical;},assertMigrationPhysicalCurrent:()=>calls.push("physical"),assertMigrationSettlementCurrent:()=>calls.push("settlement"),finishMigrationPhysical:()=>calls.push("finish"),assertMigrationSettlementConfirmed:()=>calls.push("confirmed"),finishMigrationPending:()=>calls.push("release"),closeMigrationPhysical:()=>calls.push("close")};
 h.engine=e;h.collection=id(1);h.logGen=7;Object.defineProperty(h,"alarms",{value:{current:true}});h.env={COLLECTIONS:{idFromName:()=>actor}};h.ctx={id:actor,storage:{sync:async()=>{calls.push("sync");await sync(h);}}};h.test_migrationConfirmed=new WeakMap([[ticket,{engine:e,generation:7}]]);
 return {h,calls};
}
test("receipt output waits for actual host continuation and physical guards",async()=>{
 const f=host();assert.equal(await f.h.test_commitMigrationSettlement(ticket,{rollback:body}),digest);
 assert.deepEqual(f.calls,["pending","original-receipt","begin","physical","sync","settlement","finish","confirmed","release","close"]);
 for(const sync of [async()=>{throw Error("lost-ack");},async h=>{h.logGen++;}]){
  const f=host(sync);await assert.rejects(f.h.test_commitMigrationSettlement(ticket,{rollback:body}));assert.equal(f.calls.includes("confirmed"),false);assert.equal(f.calls.includes("release"),false);
 }
});
