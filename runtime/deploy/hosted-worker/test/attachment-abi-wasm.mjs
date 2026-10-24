// Actual production attachment ABI negative boundary, not end-to-end read/memory proof.
// HOSTED_WASM=<fresh build> node --experimental-transform-types --test test/attachment-abi-wasm.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode } from "../../../packages/sdk/src/cbor.ts";
assert.ok(process.env.HOSTED_WASM);
const module = new WebAssembly.Module(readFileSync(process.env.HOSTED_WASM));
const denyHost = () => { throw new Error("unopened read must not invoke host capabilities"); };
const ex = new WebAssembly.Instance(module, { env: Object.fromEntries(WebAssembly.Module.imports(module).map(({name}) => [name, denyHost])) }).exports;
function consume(packed) {
 const pointer=Number(packed>>32n),length=Number(packed&0xffffffffn);const bytes=new Uint8Array(ex.memory.buffer,pointer,length).slice();ex.dealloc(pointer,length);return decode(bytes);
}
function rejectedInput(method,ticket,length) {
 const pointer=ex.alloc(length);new Uint8Array(ex.memory.buffer,pointer,length).fill(0x65);
 assert.equal(ex[method](ticket,pointer,length),method==="hd_attachment_call_busy"?undefined:0);
 assert.ok(new Uint8Array(ex.memory.buffer,pointer,length).every((b)=>b===0),"owned rejected input must be wiped");
}
test("unopened WASM refuses object leases and every non-safe ticket/size",()=> {
 assert.equal(consume(ex.hd_attachment_object()),null);
 for(const ticket of [0,1,-1,NaN,Infinity,1.5,2**53]) {
  assert.equal(ex.hd_attachment_allowed(ticket),0);
  assert.equal(ex.hd_attachment_reserve(ticket,1024),0);
  assert.equal(ex.hd_attachment_region(ticket,1024),0);
  assert.equal(ex.hd_attachment_written(ticket,1024),0);
  ex.hd_attachment_failed(ticket);
 }
 for(const size of [-1,NaN,Infinity,1.5,2**53,(1<<20)+1]) {
  assert.equal(ex.hd_attachment_reserve(1,size),0);
  assert.equal(ex.hd_attachment_region(1,size),0);
  assert.equal(ex.hd_attachment_written(1,size),0);
 }
});
test("unopened WASM queue preflight/busy inputs are consumed and wiped for unsafe sessions",()=> {
 for(const session of [0,1,-1,NaN,Infinity,1.5,2**53]) {
  assert.equal(ex.hd_attachment_active(session),0);
  for(const method of ["hd_attachment_call_requires_slot","hd_attachment_call_busy"])rejectedInput(method,session,32);
 }
});
test("WASM wipes rejected network/checksum allocations, including oversized input",()=> {
 for(const [method,length] of [["hd_attachment_write",1<<20],["hd_attachment_write",(1<<20)+1],["hd_attachment_complete",32],["hd_attachment_complete",31]]) rejectedInput(method,1,length);
 rejectedInput("hd_attachment_write",NaN,32);
});
