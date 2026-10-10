import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {decode,encode} from "../../../packages/sdk/src/cbor.ts";
import {IkInitiator,keyPairFromSecret} from "../../../packages/sdk/src/transport/noise.ts";
import {FrameReader,frameChunks,uuidBytes,PROLOGUE_TAG} from "../src/app.ts";
const plan=JSON.parse(readFileSync(process.argv[2],"utf8"));
const base="http://127.0.0.1:19679", empty=new Uint8Array();
const file=Uint8Array.from(Buffer.from(plan.file,"hex"));
const call=(id,method,params)=>encode(new Map([[0,0],[1,id],[2,method],[3,params]]));
class Peer {
 raw=[];frames=[];pushes=[];waiters=[];reader=new FrameReader();transport=null;closed=false;error=null;closeCode=null;
 constructor(scenario="positive"){this.scenario=scenario;}
 async open() {
  this.ws=new WebSocket(base.replace("http:","ws:")+"/app?collection="+plan.collection+"&case="+this.scenario);this.ws.binaryType="arraybuffer";
  this.ws.addEventListener("message",e=>{try{
   const bytes=new Uint8Array(e.data);
   if(!this.transport)this.raw.push(bytes);
   else {const plain=this.transport.recv.decrypt(empty,bytes);try{const frames=this.reader.push(plain);assert.ok(frames);this.frames.push(...frames);}finally{plain.fill(0);}}
  }catch(error){this.error=error;}for(const wake of this.waiters.splice(0))wake();});
  this.ws.addEventListener("close",e=>{this.closeCode=e.code;this.closed=true;for(const wake of this.waiters.splice(0))wake();});
  this.ws.addEventListener("error",()=>{this.error=Error("socket error");for(const wake of this.waiters.splice(0))wake();});
  await Promise.race([new Promise((resolve,reject)=>{this.ws.addEventListener("open",resolve,{once:true});this.ws.addEventListener("error",reject,{once:true});}),sleep(15_000,undefined,{ref:false}).then(()=>{throw Error("open timeout");})]);
  const p=new Uint8Array(64);p.set(PROLOGUE_TAG);p.set(uuidBytes(plan.collection),16);p.set(uuidBytes(plan.grant),32);p.set(uuidBytes(plan.device),48);
  this.ws.send(p);
  const init=new IkInitiator({prologue:p,staticKey:keyPairFromSecret(new Uint8Array(32).fill(81)),remoteStatic:keyPairFromSecret(new Uint8Array(32).fill(102)).publicKey});
  this.ws.send(await init.writeMessage1(call(1,"hello",new Map([[0,[[1,0]]],[1,"synthetic-grant-only"],[2,"1"]]))));
  const m2=await this.next(this.raw);const result=await init.readMessage2(m2);m2.fill(0);
  const hello=decode(result.payload);result.payload.fill(0);assert.equal(hello.get(0),1);assert.ok(hello.has(2),JSON.stringify([...hello]));
  this.transport=result.transport;return this;
 }
 async next(queue=this.frames,timeout=10_000) {
  const deadline=Date.now()+timeout;
  while(!queue.length){if(this.error)throw this.error;if(this.closed)throw Error("closed");let wake;const event=new Promise(r=>{wake=r;this.waiters.push(r);});
   try{await Promise.race([event,sleep(Math.max(1,deadline-Date.now()),undefined,{ref:false}).then(()=>{throw Error("receive timeout");})]);}finally{const i=this.waiters.indexOf(wake);if(i>=0)this.waiters.splice(i,1);}}
  return queue.shift();
 }
 send(id,method,params) {const frame=call(id,method,params);const pieces=frameChunks(frame);try{for(const p of pieces)this.ws.send(this.transport.send.encrypt(empty,p));}finally{frame.fill(0);for(const p of pieces)p.fill(0);}}
 async response(id,allowEOF=false) {for(;;){const bytes=await this.next();const f=decode(bytes);if(f.get(0)===2){this.pushes.push(bytes);f.get(2).get(2)?.fill(0);continue;}bytes.fill(0);assert.equal(f.get(0),1);assert.equal(f.get(1),id);if(!f.has(2)&&allowEOF){assert.equal(f.get(3).get(0),"not_found");assert.equal(f.get(3).get(2),"file stream is not active");assert.ok([...this.pushes,...this.frames].some(b=>{const v=decode(b);const p=v.get(2);return v.get(0)===2&&p.get(3)===true&&p.get(1)+p.get(2).length===plan.bytes;}),"late ACK refusal requires already queued terminal file chunk");return null;}assert.ok(f.has(2),JSON.stringify([...f]));return f.get(2);}}
 close(){this.ws?.close();this.reader.wipe();for(const b of [...this.raw,...this.frames,...this.pushes])b.fill(0);}
}
let peer;
try {
 // Grant-only client holds only its Noise identity: no collection signing/KEM/CK.
 peer=await new Peer().open();peer.send(10,"read_file",new Map([[0,file]]));const reply=await peer.response(10);const stream=reply.get(0);
 let bytes=0,frames=0,last=false;const hash=createHash("sha256");
 const chunk=async()=>{const raw=peer.pushes.shift() ?? await peer.next();try{const f=decode(raw);assert.equal(f.get(0),2);assert.equal(f.get(1),"file_chunk");const p=f.get(2);assert.equal(p.get(0),stream);assert.equal(p.get(1),bytes);const body=p.get(2);for(let i=0;i<body.length;i++)assert.equal(body[i],(bytes+i)%251);hash.update(body);bytes+=body.length;frames++;last=p.get(3)===true;body.fill(0);}finally{raw.fill(0);}};
 console.log(JSON.stringify({phase:"read_started",counts:await(await fetch(base+"/harness/counts")).json(),status:await(await fetch(base+"/harness/status?collection="+plan.collection)).json()}));
 let ack=20;
 // The production bridge polls one output at a time. Offset-zero ACKs drive
 // polls WITHOUT returning any byte credit: native 8MiB backpressure still binds.
 while(bytes<8<<20){await chunk();peer.send(ack++,"ack_chunks",new Map([[0,stream],[1,0]]));await peer.response(ack-1);}assert.equal(bytes,8<<20);assert.equal(last,false);
 const atWindow=await (await fetch(base+"/harness/counts")).json();await sleep(300);
 assert.equal(peer.frames.length+peer.pushes.length,0,"no plaintext beyond ACK window");assert.deepEqual(await (await fetch(base+"/harness/counts")).json(),atWindow,"no ciphertext fetch beyond ACK window");
 peer.send(ack++,"ack_chunks",new Map([[0,stream],[1,bytes]]));await peer.response(ack-1);
 while(!last){await chunk();if(!last){peer.send(ack++,"ack_chunks",new Map([[0,stream],[1,bytes]]));await peer.response(ack-1,true);}}
 assert.equal(bytes,plan.bytes);const digest=hash.digest("hex");assert.equal(digest,plan.sha256);
 // Cancellation must release the resource so the same session can read again.
 peer.send(100,"read_file",new Map([[0,file],[1,[0,4096]]]));const small=await peer.response(100);assert.ok(small.get(0));
 // Consume its terminal push (without retaining customer-like content).
 const tiny=await peer.next();const tp=decode(tiny).get(2);assert.equal(tp.get(2).length,4096);assert.equal(tp.get(3),true);tiny.fill(0);tp.get(2).fill(0);
 peer.send(101,"read_file",new Map([[0,file]]));const cancel=await peer.response(101);const cancelStream=cancel.get(0);
 for(const queue of [peer.frames,peer.pushes])while(queue.length){const b=queue.shift();b.fill(0);}peer.send(102,"cancel_stream",new Map([[0,cancelStream]]));
 // In-flight pushes can precede the cancel response; discard/wipe them.
 for(;;){const b=await peer.next();const f=decode(b);b.fill(0);if(f.get(0)===1){assert.equal(f.get(1),102);assert.ok(f.has(2));break;}if(f.get(0)===2)f.get(2).get(2).fill(0);}
 peer.send(103,"read_file",new Map([[0,file],[1,[0,4096]]]));await peer.response(103);
 const afterCancel=peer.pushes.shift() ?? await peer.next();const ac=decode(afterCancel).get(2);assert.equal(ac.get(2).length,4096);assert.equal(ac.get(3),true);ac.get(2).fill(0);afterCancel.fill(0);
 // Native log retirement is an actual loss of authority, not a fabricated deny.
 await fetch(base+"/harness/retire?collection="+plan.collection,{method:"POST"});
 peer.send(104,"read_file",new Map([[0,file],[1,[0,4096]]]));await sleep(300);assert.equal(peer.frames.length,0,"retired admission emits no output");assert.equal(peer.closed,true,"retired app session closes");
 console.log(JSON.stringify({actual_workerd:true,actual_sqlite:true,production_hosted_handlers:true,real_noise:true,grant_only_client:true,authenticated_bytes:bytes,frames,sha256:digest,ack_window_bytes:8<<20,paused_fetches:atWindow.objectFetches,cancel_pass:true,native_retirement_no_output:true,memory_qualification:false}));
} finally {peer?.close();}
try {
 peer=await new Peer("await").open();const before=await(await fetch(base+"/harness/counts")).json();
 await fetch(base+"/harness/hold",{method:"POST"});peer.send(200,"read_file",new Map([[0,file]]));await peer.response(200);
 let waiting=false;for(let i=0;i<100;i++){if((await(await fetch(base+"/harness/counts")).json()).objectWaiting===1){waiting=true;break;}await sleep(20);}assert.ok(waiting,"object await barrier reached");
 await fetch(base+"/harness/retire?collection="+plan.collection+"&case=await",{method:"POST"});
 await fetch(base+"/harness/release",{method:"POST"});
 for(let i=0;i<100&&!peer.closed;i++)await sleep(20);
 assert.equal(peer.frames.length+peer.pushes.length,0,"authority retired during object await emits no plaintext");assert.equal(peer.closed,true);
 assert.equal((await(await fetch(base+"/harness/counts")).json()).objectFetches,before.objectFetches+1,"no subsequent chunk fetch after retirement");
 console.log(JSON.stringify({retirement_during_object_await:true,plaintext_outputs:0}));
} finally {await fetch(base+"/harness/release",{method:"POST"});peer?.close();}
try {
 peer=await new Peer("stale").open();const before=await(await fetch(base+"/harness/counts")).json();
 await fetch(base+"/harness/stale?collection="+plan.collection+"&case=stale",{method:"POST"});
 peer.send(201,"read_file",new Map([[0,file]]));for(let i=0;i<100&&!peer.closed;i++)await sleep(20);
 assert.equal(peer.closeCode,1012);assert.equal(peer.frames.length+peer.pushes.length,0);
 assert.equal((await(await fetch(base+"/harness/counts")).json()).objectFetches,before.objectFetches);
 console.log(JSON.stringify({stale_wake_rehandshake:true,plaintext_outputs:0,object_fetches:0}));
} finally {peer?.close();}
