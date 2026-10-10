import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkSlots, ChunkBusy } from "../src/chunk-slots.ts";
test("isolate pool permits one stream, bounds waiting calls and transfers FIFO once", async () => {
 const pool=new ChunkSlots(1,1000,1000), first=await pool.acquire();
 let granted=false;
 const pending=pool.acquire().then(p=>{granted=true;return p;});
 await assert.rejects(pool.acquire(),e=>e instanceof ChunkBusy&&e.reason==="hosted_chunk_busy"&&e.retryAfterMs===1000);
 assert.equal(granted,false);first.release();first.release();
 const second=await pending;assert.equal(second.active,true);assert.equal(first.active,false);second.release();
});
test("aborted queued caller holds no queue capacity or future permit", async()=>{
 const pool=new ChunkSlots(1,1000,1000),first=await pool.acquire(),controller=new AbortController();
 const waiting=pool.acquire(controller.signal);controller.abort();await assert.rejects(waiting,ChunkBusy);
 const next=pool.acquire();first.release();(await next).release();
 await assert.rejects(pool.acquire(AbortSignal.abort()),ChunkBusy);
});
test("queue timeout is a typed busy refusal, not an unbounded retained request", async()=>{
 const pool=new ChunkSlots(1,5,1000),first=await pool.acquire();
 await assert.rejects(pool.acquire(),ChunkBusy);first.release();(await pool.acquire()).release();
});
test("idle permit expires and cannot be revived by old progress", async()=>{
 const pool=new ChunkSlots(1,1000,5),first=await pool.acquire();
 const second=await pool.acquire();assert.equal(first.active,false);first.touch();assert.equal(first.active,false);
 assert.equal(second.active,true);second.release();
});
