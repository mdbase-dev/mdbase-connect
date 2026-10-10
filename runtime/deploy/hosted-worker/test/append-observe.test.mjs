import {test} from "node:test";import assert from "node:assert/strict";
import {encode} from "../../../packages/sdk/src/cbor.ts";
import {appendObservation,boundedAppendObservation} from "../src/append-observe.ts";
import {sendCall,StaleAppendStore} from "../src/log.ts";
import {wakeLog} from "../src/wake-observe.ts";
const q=encode(new Map([[0,0],[1,9],[2,"append"],[3,new Map()]]));
const result=n=>encode(new Map([[0,1],[1,9],[2,[n,new Map()]]]));
const refusal=(code="forbidden",reason="role")=>encode(new Map([[0,1],[1,9],[3,new Map([[0,code],[1,reason],[2,"private-token response"],[4,"customer-address"]])]]));
test("bounded append results distinguish commit, CAS, duplicate and role refusal",()=>{
 for(const [n,outcome] of [[0,"appended"],[1,"head_moved"],[2,"duplicate"]])assert.deepEqual(appendObservation(q,result(n)),{outcome});
 assert.deepEqual(appendObservation(q,refusal()),{outcome:"refused",code:"forbidden",reason:"role"});
 assert.deepEqual(appendObservation(q,refusal("private-token","customer-id")),{outcome:"refused",code:"other",reason:"other"});
 assert.equal(appendObservation(q,new Uint8Array(65537)).outcome,"malformed");
 assert.equal(appendObservation(q,encode(new Map([[0,1],[1,10],[2,[0,new Map()]]]))).outcome,"malformed");
});
test("logging boundary keeps only whitelisted outcome fields, never payloads",()=>{
 const old=console.info,seen=[];console.info=x=>seen.push(x);
 try{wakeLog("12".repeat(12),"hosted","grant_append_outcome",{outcome:"refused",code:"forbidden",reason:"role",http_status:200,token:"private-token",body:"customer-content"});}finally{console.info=old;}
 const v=JSON.parse(seen[0]);assert.equal(v.reason,"role");assert.equal(v.code,"forbidden");assert.equal(v.phase,"grant_append_outcome");assert.ok(!seen[0].includes("private-token"));assert.ok(!seen[0].includes("customer-content"));
 assert.deepEqual(boundedAppendObservation({outcome:"secret",code:"secret",reason:"secret",http_status:1e9}),{outcome:"malformed",code:"other",reason:"other"});
});
function spy(){return {seen:[],signRpc:()=>new Uint8Array(64),logReply(){this.seen.push("reply")},logFailed(){this.seen.push("failed")}}}
function log(rpc){return {async fetch(url){return url.endsWith("/nonce")?new Response("ab".repeat(32)):rpc()}}}
test("response observation cannot throw into transport and stale replies are not observed",async()=>{
 const e=spy(),seen=[];await sendCall(log(()=>new Response(refusal())),e,"secret-token",{id:9,frame:q},()=>true,new StaleAppendStore(),(_,o)=>{seen.push(o);throw Error("diagnostic failure")});assert.deepEqual(seen,[{outcome:"refused",code:"forbidden",reason:"role"}]);assert.deepEqual(e.seen,["reply"]);
 let live=true;const stale=new StaleAppendStore(),e2=spy();await sendCall(log(()=>{live=false;return new Response(result(0))}),e2,"secret-token",{id:9,frame:q},()=>live,stale,()=>assert.fail("stale observer"));assert.equal(stale.count,1);assert.deepEqual(e2.seen,[]);
});
test("transport/HTTP failures emit only bounded categories, with a fence after observation",async()=>{
 for(const [rpc,expected] of [[()=>{throw Error("private-url secret-token")},{outcome:"transport_error"}],[()=>new Response("private response",{status:403}),{outcome:"http_error",http_status:403}]]){const e=spy(),seen=[];await sendCall(log(rpc),e,"secret-token",{id:9,frame:q},()=>true,new StaleAppendStore(),(_,o)=>seen.push(o));assert.deepEqual(seen,[expected]);assert.deepEqual(e.seen,["failed"]);}
 let live=true;const e=spy(),stale=new StaleAppendStore();await sendCall(log(()=>new Response(result(0))),e,"secret-token",{id:9,frame:q},()=>live,stale,()=>{live=false});assert.deepEqual(e.seen,[]);assert.equal(stale.count,1);
});
