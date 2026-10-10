import {test} from "node:test";
import assert from "node:assert/strict";
import {LIVE_MEMORY_BUDGET,liveMemoryBound} from "./live-memory-bound.mjs";
test("live bound includes separate isolate WASM backing, not only inspector counters",()=>{
 assert.deepEqual(liveMemoryBound(3826329,23855104),{conservative_bytes:27681433,budget_bytes:LIVE_MEMORY_BUDGET,passed:true});
 assert.throws(()=>liveMemoryBound(3826329,23855104+(9<<20)),/regressed/);
 assert.throws(()=>liveMemoryBound(3826329+(9<<20),23855104),/regressed/);
});
test("missing, negative, fractional and overflowing accounting fails closed",()=>{
 for(const n of [undefined,NaN,Infinity,0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
  assert.throws(()=>liveMemoryBound(n,23855104));assert.throws(()=>liveMemoryBound(3826329,n));
 }
 assert.equal(liveMemoryBound(1,LIVE_MEMORY_BUDGET-1).conservative_bytes,LIVE_MEMORY_BUDGET);
 assert.throws(()=>liveMemoryBound(1,LIVE_MEMORY_BUDGET),/regressed/);
});
