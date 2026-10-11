import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Real constructor and callback code; platform/WASM ports only are mocked.
async function load(entry) {
  const out=await build({entryPoints:[new URL(`../src/${entry}.ts`,import.meta.url).pathname],bundle:true,write:false,format:"esm",platform:"node",plugins:[{
    name:"closed-actor-ports",setup(b){
      b.onResolve({filter:/^cloudflare:workers$/},()=>({path:"state",namespace:"fake-platform"}));
      b.onLoad({filter:/.*/,namespace:"fake-platform"},()=>({contents:"export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }"}));
      b.onResolve({filter:/hosted\.wasm$/},()=>({path:"wasm",namespace:"fake-wasm"}));
      b.onLoad({filter:/.*/,namespace:"fake-wasm"},()=>({contents:"export default new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));"}));
    }
  }]});
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const required=await load("pitr-worker"),shared=await load("worker");
function state(){
  const calls=[];const ws={close(...args){calls.push(["socket-close",...args]);},send(){assert.fail("socket egress");},deserializeAttachment(){assert.fail("stored session consumption");}};
  return {calls,ws,ctx:{id:{toString:()=>"04".repeat(32)},waitUntil(promise){void promise.catch(()=>{});},
    storage:{async deleteAlarm(){calls.push("deleteAlarm");},async get(){assert.fail("restored SQL/KV admission");},async put(){assert.fail("storage authority writes");},async setAlarm(){assert.fail("reschedule");},sql:{exec(){assert.fail("SQL open");}}},
    getWebSockets(){return [ws];},setWebSocketAutoResponse(...args){assert.equal(args.length,0);calls.push("disable-auto-response");}}};
}
function env(extra={}){
  const e={LAB:"1",...extra};
  for(const key of ["LAB_HOSTED_CONFIG","HOSTED_SERVICE_TOKEN","HOSTED_KMS_PROVIDER","HOSTED_KMS_KEY_ID"]){
    Object.defineProperty(e,key,{get(){assert.fail(`closed actor read ${key}`);}});
  }
  return e;
}

test("required profile's actor is CLOSED even with every PITR binding missing",async()=>{
  const s=state(),actor=new required.HostedCollection(s.ctx,env());
  assert.equal(actor.production,null);assert.equal(actor.engine,null);assert.equal(actor.pitrWork.drained,true);
  assert.deepEqual(s.calls,["disable-auto-response",["socket-close",1012,"pitr closed"]]);
  for(const path of ["activate","migration-admission","app","status","wake"]){
    const r=await actor.fetch(new Request(`https://synthetic.test/v1/hosted/${path}?collection=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa`));
    assert.equal(r.status,503);assert.equal(r.headers.get("cache-control"),"no-store");
  }
  await actor.alarm();assert.equal(s.calls.filter(c=>c==="deleteAlarm").length,1);
  await actor.webSocketMessage(s.ws,new ArrayBuffer(0));await actor.webSocketClose(s.ws);await actor.webSocketError(s.ws);
  await assert.rejects(actor.ready("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"),/pitr_actor_closed/);
});

test("any partial PITR setting closes the shared actor rather than falling back to fixture/production custody",async()=>{
  for(const extra of [{PITR_BINDING:""},{PITR_MINIMUM_EPOCH:"1"},{PITR_PHASE:{}},{PITR_ESCROW_SERVICE_TOKEN:"synthetic"}]){
    const s=state(),actor=new shared.HostedCollection(s.ctx,env(extra));
    assert.equal(actor.production,null);assert.equal(actor.pitrWork.drained,true);
    assert.equal((await actor.fetch(new Request("https://synthetic.test/status"))).status,503);
    await actor.alarm();assert.equal(s.calls.at(-1),"deleteAlarm");
  }
});

test("closed final output is discarded/wiped, including the LAB plaintext path",()=>{
  const s=state(),actor=new required.HostedCollection(s.ctx,env());
  const frame=new Uint8Array([1,2,3]);const engine={poll:()=>[{session:1,frame}]};
  actor.deliver(engine);assert.deepEqual([...frame],[0,0,0]);
  assert.equal(actor.attachmentAdmitted(engine,1),false);
  assert.equal(actor.admitted(engine,{collection:"synthetic",op:"output"}),false);
});

test("closed sync continuation does not poll, copy objects or schedule alarms",async()=>{
  const s=state(),actor=new required.HostedCollection(s.ctx,env());
  const engine={hasIo(){assert.fail("background I/O");}};
  actor.engine=engine;await actor.sync(engine); // stale/native engine injection does not remove the restriction.
});
