// Inspector counters only. Optional GC is MEASURING HARNESS ONLY, per approval.
// No heap snapshots, raw objects, customer data, LAB or provider access.
import assert from "node:assert/strict";
import {liveMemoryBound} from "./live-memory-bound.mjs";
const forceGC=process.env.FORCE_ATTACHMENT_GC==="1";
let target;
for(let i=0;i<40;i++){try{target=(await(await fetch("http://127.0.0.1:19670/json/list")).json())[0];if(target)break;}catch{}await new Promise(r=>setTimeout(r,50));}
assert.ok(target?.webSocketDebuggerUrl);
const ws=new WebSocket(target.webSocketDebuggerUrl),pending=new Map();let sequence=0;
let queuedRun,queuedError,gcError,gcSerial=Promise.resolve();
const names=["usedSize","totalSize","embedderHeapUsedSize","backingStorageSize"];
const peaks=Object.fromEntries(names.map(n=>[n,0])),livePeaks={...peaks};
let samples=0,liveSamples=0,combinedPeak=0,liveCombinedPeak=0;
function record(usage,live=false){const p=live?livePeaks:peaks;for(const n of names)if(typeof usage[n]==="number")p[n]=Math.max(p[n],usage[n]);const sum=(usage.usedSize??0)+(usage.embedderHeapUsedSize??0)+(usage.backingStorageSize??0);if(live){liveCombinedPeak=Math.max(liveCombinedPeak,sum);liveSamples++;}else{combinedPeak=Math.max(combinedPeak,sum);samples++;}}
ws.addEventListener("message",event=>{
 const message=JSON.parse(event.data);
 if(message.id){const p=pending.get(message.id);pending.delete(message.id);if(p){clearTimeout(p.timer);message.error?p.reject(Error("inspector method unavailable")):p.resolve(message.result);}return;}
 if(message.method!=="Runtime.consoleAPICalled")return;
 const marker=message.params?.args?.[0]?.value;
 if(marker==="attachment_test_overlap_start"&&!queuedRun){queuedRun=fetch("http://127.0.0.1:19669/queued").then(async r=>{assert.equal(r.status,200);return r.json();}).catch(e=>{queuedError=e;return null;});}
 if((marker==="attachment_test_chunk_retained"||marker==="attachment_test_chunk_retained_solo")&&forceGC){gcSerial=gcSerial.then(async()=>{await command("HeapProfiler.collectGarbage");const usage=await command("Runtime.getHeapUsage");record(usage);if(marker==="attachment_test_chunk_retained")record(usage,true);}).catch(e=>{gcError=e;});}
});
await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
function command(method){return new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error("inspector command timeout"));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method}));});}
await command("Runtime.enable");
const baseline=await command("Runtime.getHeapUsage");
let done=false,runError;
const run=fetch("http://127.0.0.1:19669/fixture").then(async r=>{assert.equal(r.status,200);return r.json();}).catch(e=>{runError=e;return null;}).finally(()=>{done=true});
try {
 while(!done&&samples<10000){record(await command("Runtime.getHeapUsage"));await new Promise(r=>setTimeout(r,10));}
 const result=await run;if(runError)throw runError;await gcSerial;assert.ok(queuedRun);const queued=await queuedRun;
 if(queuedError)throw queuedError;if(gcError)throw gcError;
 assert.equal(result.engine_instances_peak,2);assert.equal(queued.ciphertext_fetches,0);
 if(forceGC)assert.ok(liveSamples>0);
 const liveBound=forceGC?liveMemoryBound(liveCombinedPeak,result.wasm_linear_per_isolate_peak_bytes):null;
 console.log(JSON.stringify({result,queued,forced_gc_between_authenticated_chunks:forceGC,inspector_heap_peaks:peaks,baseline,combined_sampled_peak:combinedPeak,samples,post_gc_live_peaks:forceGC?livePeaks:null,post_gc_live_combined_peak:forceGC?liveCombinedPeak:null,post_gc_live_samples:liveSamples,live_memory_guard:liveBound,wasm_linear_per_isolate_peak_bytes:result.wasm_linear_per_isolate_peak_bytes,post_gc_live_combined_conservative_upper_bound:forceGC?liveCombinedPeak+result.wasm_linear_per_isolate_peak_bytes:null,wasm_accounting:"WASM linear memory added separately: inspector backingStorageSize excludes its native retained backing after GC; adding the isolate high-water mark is conservative",memory_scope:"one active stream plus one native READ-preflighted queued call, two WASM engines in one isolate; no Noise qualification",full_32mib_qualification:false}));
} finally {ws.close();for(const p of pending.values())clearTimeout(p.timer);}
