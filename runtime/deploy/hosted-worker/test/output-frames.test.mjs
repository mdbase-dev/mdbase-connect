import { test } from "node:test";
import assert from "node:assert/strict";
import { encode } from "../../../packages/sdk/src/cbor.ts";
import { outputFrames } from "../src/output-frames.ts";
test("native output views share only owned JS envelope; no body clone",()=>{
 for(const size of [0,1,24,256,65536,1<<20]) {
  const raw=encode([[23,new Uint8Array(size).fill(71)],[Number.MAX_SAFE_INTEGER,null],[24,Uint8Array.of(1,2,3)]]);
  const out=outputFrames(raw);assert.equal(out.length,3);assert.equal(out[0].frame.length,size);
  assert.equal(out[0].frame.buffer,raw.buffer);assert.equal(out[2].frame.buffer,raw.buffer);
  assert.equal(out[1].frame,null);assert.equal(out[1].session,Number.MAX_SAFE_INTEGER);
  assert.ok(out[0].frame.every(b=>b===71));out[0].frame.fill(0);assert.deepEqual([...out[2].frame],[1,2,3]);
 }
});
test("malformed/noncanonical/unsafe output envelope fails closed and wipes",()=>{
 for(const bytes of [[],[0x81],[0x81,0x83,0,0xf6,0xf6],[0x81,0x82,0,0x41],[0x81,0x82,0,0x60],[0x80,0],[0x98,0],[0x81,0x82,0x18,0,0xf6], [...encode([[2n**53n,null]])]]) {
  const raw=Uint8Array.from(bytes);assert.throws(()=>outputFrames(raw));assert.ok(raw.every(b=>b===0));
 }
 assert.deepEqual(outputFrames(Uint8Array.of(0x80)),[]);
});
