import assert from "node:assert/strict";
export const LIVE_MEMORY_BUDGET = 32 << 20;
/** Conservative live bound: workerd inspector omits native WASM backing after
 * GC, so add the separately sampled isolate-wide WASM high-water. No module
 * binary, heap snapshots, private objects, or production GC are involved. */
export function liveMemoryBound(inspectorCombined, wasmIsolateHighWater) {
 for(const n of [inspectorCombined,wasmIsolateHighWater])assert.ok(Number.isSafeInteger(n)&&n>0,"missing/invalid live memory counters");
 const bytes=inspectorCombined+wasmIsolateHighWater;
 assert.ok(Number.isSafeInteger(bytes)&&bytes<=LIVE_MEMORY_BUDGET,"hosted attachment live memory bound regressed");
 return {conservative_bytes:bytes,budget_bytes:LIVE_MEMORY_BUDGET,passed:true};
}
