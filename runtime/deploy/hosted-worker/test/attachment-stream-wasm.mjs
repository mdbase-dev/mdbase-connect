// Actual production WASM + real signed synthetic policy/attachment + SQLite host.
// Hermetic log transport; NOT workerd/Noise/live app-admission qualification.
import { readFileSync, openSync,readSync,closeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { Engine, encode, decode } from "./attachment-stream-bundle.mjs";
assert.ok(process.env.ATTACHMENT_FIXTURE);
const root=process.env.ATTACHMENT_FIXTURE, fixture=decode(readFileSync(join(root,"fixture.cbor")));
const db=new DatabaseSync(":memory:");
const storage={transactionSync(f){db.exec("BEGIN");try{const result=f();db.exec("COMMIT");return result;}catch(e){db.exec("ROLLBACK");throw e;}},sql:{exec(sql,...args){const st=db.prepare(sql);st.setReturnArrays(true);const columns=st.columns().map(c=>c.name),rows=st.all(...args.map(a=>a instanceof ArrayBuffer?new Uint8Array(a):a));return {columnNames:columns,one:()=>Object.fromEntries(columns.map((c,i)=>[c,rows[0][i]])),*raw(){for(const r of rows)yield r.map(v=>v instanceof Uint8Array?v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength):v);}};}}};
const engine=new Engine(storage);engine.open(fixture.get(0));assert.ok(engine.logBind());
const items=fixture.get(1),head=items.length,chain=fixture.get(8);
function pump(){for(let round=0;round<64;round++){const calls=engine.logCalls();if(!calls.length)return;for(const c of calls){const call=decode(c.frame),method=call.get(2),p=call.get(3);let result;if(method==="head")result=new Map([[0,head],[1,chain],[2,1]]);else if(method==="read"){const kind=p.get(3);result=new Map([[0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>i>p.get(1)&&(kind!==1||[2,3,4,5,6].includes(decode(b).get(1))))],[1,head],[2,chain],[3,1],[4,false],[6,false]]);}else throw Error(`unexpected fixture log method ${method}`);engine.logReply(c.id,encode(new Map([[0,1],[1,call.get(1)],[2,result]])));c.frame.fill(0);}}throw Error("pump bounded");}
pump();assert.ok(engine.serving(),`not serving: ${JSON.stringify(engine.admission())}`);
const hello=engine.hello(fixture.get(4),encode(new Map([[0,0],[1,1],[2,"hello"],[3,new Map([[0,[[1,0]]],[1,"fixture"],[2,"1"]])]])));assert.ok(hello.session,"approved signed grant hello");
let request=10;const session=hello.session;
let wasmPeak=engine.ex.memory.buffer.byteLength,jsBuffersPeak=0;
function sample(){wasmPeak=Math.max(wasmPeak,engine.ex.memory.buffer.byteLength);jsBuffersPeak=Math.max(jsBuffersPeak,process.memoryUsage().arrayBuffers);}
function frame(method,params){engine.frame(session,encode(new Map([[0,0],[1,request++],[2,method],[3,params]])));sample();}
function outputs(){const out=engine.poll();sample();return out.map(o=>{assert.equal(o.session,session);const value=o.frame?decode(o.frame):null;o.frame?.fill(0);return value;});}
frame("read_file",new Map([[0,fixture.get(3)]]));const response=outputs().find(v=>v?.get(0)===1);assert.ok(response&&!response.has(3),"read_file response");const stream=response.get(2).get(0);const hasher=createHash("sha256");let count=0,done=false,objects=0;
for(let turn=0;turn<2048&&!done;turn++){
 const lease=engine.attachmentObject();if(lease){const call=decode(lease.frame),address=Buffer.from(call.get(3).get(1)).toString("hex");const descriptor=fixture.get(7).find(d=>Buffer.from(d[0]).toString("hex")===address);assert.ok(descriptor);assert.ok(engine.attachmentReserve(lease.ticket,descriptor[1]));const fd=openSync(join(root,descriptor[2]),"r"),digest=createHash("sha256");try{let offset=0;const input=Buffer.alloc(1<<20);while(offset<descriptor[1]){const n=readSync(fd,input,0,Math.min(input.length,descriptor[1]-offset),offset);assert.ok(n);digest.update(input.subarray(0,n));assert.ok(engine.attachmentWrite(lease.ticket,input.subarray(0,n)));input.fill(0);offset+=n;sample();}}finally{closeSync(fd);}assert.ok(engine.attachmentComplete(lease.ticket,digest.digest()));lease.frame.fill(0);objects++;sample();}
 for(const push of outputs()){if(push?.get(0)!==2)continue;assert.equal(push.get(1),"file_chunk");const p=push.get(2);assert.equal(p.get(0),stream);assert.equal(p.get(1),count);const bytes=p.get(2);hasher.update(bytes);count+=bytes.length;done=p.get(3);bytes.fill(0);frame("ack_chunks",new Map([[0,stream],[1,count]]));}
}
assert.ok(done);assert.equal(count,fixture.get(6));assert.equal(hasher.digest("hex"),Buffer.from(fixture.get(2)).toString("hex"));engine.close(session);db.close();console.log(JSON.stringify({actual_production_wasm:true,synthetic_signed_fixture:true,authenticated_bytes:count,objects,wasm_linear_peak_bytes:wasmPeak,node_array_buffers_peak_bytes:jsBuffersPeak,full_32mib_qualification:false}));
