// Hermetic actual workerd/SQLite + production Engine. No LAB/provider claims.
import { Engine } from "../src/engine.ts";
import { attachmentSlots, ChunkBusy } from "../src/chunk-slots.ts";
import { encode, decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
interface Env { FIXTURES: Fetcher; COLLECTIONS: DurableObjectNamespace; }
let engines = 0, enginePeak = 0, queuedReady = false, wasmIsolatePeak = 0;
// Measurement-only strong ArrayBuffer wrappers. V8's backingStorageSize can
// otherwise stop accounting for LIVE WASM memory after collecting its wrapper.
// No byte views are retained; production still acquires each view synchronously.
const wasmBackings = new Map<Engine, ArrayBuffer>();
function pinWasm(engine: Engine): void {
 wasmBackings.set(engine,(engine as unknown as {ex:{memory:WebAssembly.Memory}}).ex.memory.buffer);
 let total=0;
 for(const e of wasmBackings.keys()) {
  const buffer=(e as unknown as {ex:{memory:WebAssembly.Memory}}).ex.memory.buffer;
  wasmBackings.set(e,buffer);total+=buffer.byteLength;
 }
 wasmIsolatePeak=Math.max(wasmIsolatePeak,total);
}
export class AttachmentFixture {
 constructor(private ctx: DurableObjectState, private env: Env) {}
 async fetch(request: Request): Promise<Response> {
  const queueOnly = new URL(request.url).pathname === "/queued";
  const fixture = decode(new Uint8Array(await (await this.env.FIXTURES.fetch("https://fixture/fixture.cbor")).arrayBuffer())) as Map<number,CborValue>;
  const engine = new Engine(this.ctx.storage);
  engines++; enginePeak = Math.max(enginePeak, engines);
  engine.open(fixture.get(0) as Uint8Array);
  if (!engine.logBind()) throw Error("bind");
  const items = fixture.get(1) as Uint8Array[], head = items.length, chain = fixture.get(8);
  for (let round=0;round<64;round++) {
   const calls=engine.logCalls(); if(!calls.length)break;
   for(const call of calls) {
    const q=decode(call.frame) as Map<number,CborValue>, method=q.get(2), p=q.get(3) as Map<number,CborValue>; let result:CborValue;
    if(method==="head")result=new Map<number,CborValue>([[0,head],[1,chain!],[2,1]]);
    else if(method==="read")result=new Map<number,CborValue>([[0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>Number(i)>Number(p.get(1))&&(p.get(3)!==1||[2,3,4,5,6].includes(Number((decode(b as Uint8Array) as Map<number,CborValue>).get(1)))))],[1,head],[2,chain!],[3,1],[4,false],[6,false]]);
    else throw Error("fixture method");
    engine.logReply(call.id,encode(new Map<number,CborValue>([[0,1],[1,q.get(1)!],[2,result]]))); call.frame.fill(0);
   }
  }
  if(!engine.serving())throw Error("serving");
  const session=engine.hello(fixture.get(4) as Uint8Array,encode(new Map<number,CborValue>([[0,0],[1,1],[2,"hello"],[3,new Map<number,CborValue>([[0,[[1,0]]],[1,"fixture"],[2,"1"]])]]))).session;
  if(!session)throw Error("hello"); let rpc=10;
  const frame=(method:string,p:CborValue)=>engine.frame(session,encode(new Map<number,CborValue>([[0,0],[1,rpc++],[2,method],[3,p]])));
  const readFrame=encode(new Map<number,CborValue>([[0,0],[1,rpc++],[2,"read_file"],[3,new Map<number,CborValue>([[0,fixture.get(3)!]])]]));
  if(!engine.attachmentCallRequiresSlot(session,readFrame))throw Error("READ preflight");
  pinWasm(engine);
  // Calling acquire synchronously enqueues; no ciphertext fetch may precede it.
  const waiting=attachmentSlots.acquire();
  if(queueOnly) { queuedReady=true; console.log("attachment_test_queue_ready"); }
  let permit;
  try { permit=await waiting; }
  catch(error) {
   if(!queueOnly||!(error instanceof ChunkBusy))throw error;
   engine.attachmentCallBusy(session,readFrame);
   const reply=engine.poll().map(o=>o.frame?decode(o.frame) as Map<number,CborValue>:null).find(v=>v?.get(0)===1);
   const problem=reply?.get(3) as Map<number,CborValue>;
   if(problem?.get(0)!=="unavailable"||problem.get(3)!=="hosted_chunk_busy")throw Error("native busy reply");
   readFrame.fill(0);engine.close(session);wasmBackings.delete(engine);engines--;queuedReady=false;
   return Response.json({queued:true,policy_preflight:true,policy_rechecked:true,busy_refused:true,ciphertext_fetches:0});
  }
  try {
   if(!permit.active)throw Error("expired resource permit");
   engine.frame(session,readFrame); readFrame.fill(0);
   if(!engine.attachmentActive(session))throw Error("READ recheck");
   if(queueOnly) return Response.json({queued:true,policy_preflight:true,policy_rechecked:true,ciphertext_fetches:0});
   const response=engine.poll().map(o=>o.frame?decode(o.frame) as Map<number,CborValue>:null).find(v=>v?.get(0)===1);
   if(!response||response.has(3))throw Error("read"); const stream=(response.get(2) as Map<number,CborValue>).get(0)!;
   const descriptors=fixture.get(7) as [Uint8Array,number,string][];
   let bytes=0,objects=0,done=false,wasmPeak=0;
   const sample=()=>{pinWasm(engine);wasmPeak=Math.max(wasmPeak,wasmBackings.get(engine)!.byteLength);};
   for(let turn=0;turn<2048&&!done;turn++) {
    const lease=engine.attachmentObject();
    if(lease) {
     const q=decode(lease.frame) as Map<number,CborValue>,address=(q.get(3) as Map<number,CborValue>).get(1) as Uint8Array;
     const d=descriptors.find(d=>d[0].every((b,i)=>b===address[i]));
     if(!d||!engine.attachmentReserve(lease.ticket,d[1]))throw Error("reserve");
     const r=await this.env.FIXTURES.fetch("https://fixture/"+d[2]); if(!r.ok||!r.body)throw Error("object");
     const reader=r.body.getReader({mode:"byob"}); let scratch=new Uint8Array(64<<10), offset=0;
     try {
      for(;;) {
       const {done,value}=await reader.read(scratch);
       if(value) {
        try { if(value.length&&!engine.attachmentWrite(lease.ticket,value))throw Error("supply");offset+=value.length; }
        finally {value.fill(0);scratch=new Uint8Array(value.buffer);}
       }
       sample(); if(done)break;
      }
     } finally {try{scratch.fill(0);}catch{/* transferred */}reader.releaseLock();}
     if(offset!==d[1]||!engine.attachmentComplete(lease.ticket,d[0]))throw Error("authenticate");
     lease.frame.fill(0);objects++;sample();
     if(objects===2) {
      // Test-only barrier: observer starts exactly one policy-preflighted waiter.
      console.log("attachment_test_overlap_start");
      for(let spin=0;!queuedReady&&spin<100;spin++)await scheduler.wait(10);
      if(!queuedReady||engines!==2)throw Error("overlap not established");
     }
     if(objects>=2) {
      // Native chunk is authenticated and retained; no output has been emitted.
      // External inspector may collect garbage HERE, never in production code.
      console.log(queuedReady&&engines===2?"attachment_test_chunk_retained":"attachment_test_chunk_retained_solo");
      await scheduler.wait(50);
     }
    }
    for(const o of engine.poll()) {
     if(!o.frame)throw Error("closed"); const v=decode(o.frame) as Map<number,CborValue>;o.frame.fill(0);if(v.get(0)!==2)continue;
     const p=v.get(2) as Map<number,CborValue>;if(p.get(0)!==stream||p.get(1)!==bytes)throw Error("offset");
     const chunk=p.get(2) as Uint8Array;for(let i=0;i<chunk.length;i++)if(chunk[i]!==((bytes+i)%251))throw Error("bytes");
     bytes+=chunk.length;done=p.get(3)===true;chunk.fill(0);frame("ack_chunks",new Map<number,CborValue>([[0,stream],[1,bytes]]));sample();
    }
    permit.touch();await scheduler.wait(1);if(!permit.active)throw Error("expired resource permit");
   }
   if(!done||bytes!==fixture.get(6))throw Error("incomplete");
   return Response.json({actual_workerd:true,actual_sqlite:true,authenticated_bytes:bytes,objects,wasm_linear_peak_bytes:wasmPeak,wasm_linear_per_isolate_peak_bytes:wasmIsolatePeak,wasm_backings_pinned_for_inspector:true,engine_instances_peak:enginePeak,active_streams:1,queued_read_calls:1,queued_ciphertext_fetches:0,full_32mib_qualification:false,noise_admission_qualification:false});
  } finally {readFrame.fill(0);engine.close(session);permit.release();wasmBackings.delete(engine);engines--;}
 }
}
export default {fetch(r:Request,env:Env){return env.COLLECTIONS.get(env.COLLECTIONS.idFromName(new URL(r.url).pathname)).fetch(r);}};
