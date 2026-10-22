// Hermetic qualification: actual production WASM/SQLite/SDK Noise, fixed PUBLIC
// synthetic lab_fixture app values, fake log + CP transports only. No Worker/DO,
// deployment, app hello/serving hook, current run/physical/phase/effect authority.
// Consume the fixture owner's repaired output; do not edit/replace its generator.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { ControlClient } from "../src/control.ts";
import { PITR_RUN } from "../src/pitr-phase.ts";
const bin=process.env.HOSTED_WASM, input=process.env.PITR_APP_FIXTURE;
if(!bin||!input)throw Error("fresh HOSTED_WASM and repaired PITR_APP_FIXTURE required");
const fixtureBytes=await readFile(resolve(input));assert.ok(fixtureBytes.length<=128*1024);
const manifestBytes=await readFile(resolve(process.env.PITR_APP_FIXTURE_MANIFEST??input.replace(/\.json$/,".manifest.json")));assert.ok(manifestBytes.length<=8192);
const manifest=JSON.parse(manifestBytes.toString("utf8"));
assert.equal(manifest.bytes,fixtureBytes.length);assert.equal(manifest.sha256,createHash("sha256").update(fixtureBytes).digest("hex"));
assert.match(manifest.sourceHead,/^[0-9a-f]{40}$/);assert.equal(manifest.publicFixedTestValuesOnly,true);
// Manifest is owner-attributed provenance only, not trust/admission/permission.
const f=JSON.parse(fixtureBytes.toString("utf8"));
const fixed=(v,n,b)=>assert.equal(v,b.repeat(n),"PUBLIC synthetic fixture only");
assert.equal(f.collection,"0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e");
fixed(f.hosted.sign_sk,32,"43");fixed(f.hosted.kem_sk,32,"44");fixed(f.hosted.noise_sk,32,"47");fixed(f.app.client_sk,32,"48");
assert.equal(f.app.grant,"49494949-4949-4949-4949-494949494949");
const wasm=await readFile(resolve(bin));
const compiled=await build({stdin:{contents:'export {Engine,encode,decode} from "../src/engine.ts"; export {IkInitiator,keyPairFromSecret} from "../../../packages/sdk/src/transport/noise.ts";',resolveDir:new URL(".",import.meta.url).pathname},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"actual-native",setup(b){b.onLoad({filter:/hosted\.wasm$/},()=>({contents:`export default new WebAssembly.Module(Uint8Array.from(Buffer.from('${wasm.toString("base64")}','base64')));`}));}}]});
const {Engine,encode,decode,IkInitiator,keyPairFromSecret}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const hexBytes=(s,n)=>{assert.match(s,/^[0-9a-f]+$/);assert.equal(s.length,n*2);return new Uint8Array(Buffer.from(s,"hex"));};
const uuid=s=>hexBytes(s.replaceAll("-",""),16);
const sha=b=>new Uint8Array(createHash("sha256").update(b).digest());
const chain=b=>{const domain=Buffer.from("mdbase/v1/chain");return sha(Buffer.concat([Buffer.from([domain.length]),domain,b]));};
// Fixed, independently bundled PUBLIC test trust literal, not pins learned from
// the input record, CPP reply or SQL. Native still verifies every signature.
const declared=JSON.parse(await readFile(new URL("./fixtures/public-genesis.json",import.meta.url),"utf8"));
const pins=new Uint8Array(Buffer.from(declared.pins,"base64"));
const trusted=decode(pins),rootPK=trusted[0][0][1],policyPK=trusted[1][0][1];
assert.equal(f.root_pk,Buffer.from(rootPK).toString("hex"));assert.equal(f.cp_pk,Buffer.from(policyPK).toString("hex"));
assert.ok(Array.isArray(f.items)&&f.items.length===2,"original policy + real initial HPKE rekey fixture");
const items=f.items.map(s=>{assert.ok(s.length<=2*65536);return hexBytes(s,s.length/2);});
const genesis=items[0],payload=decode(decode(genesis).get(11));
const ops=payload.get(3);assert.ok(Array.isArray(ops));
const genesisOp=ops.find(o=>o.get(0)===1),grantOp=ops.find(o=>o.get(0)===6);
assert.ok(genesisOp&&grantOp,"exact original signed Genesis and Grant required");
const owner=genesisOp.get(1),installation=grantOp.get(2);
assert.equal(Buffer.from(grantOp.get(1)).toString("hex"),"49".repeat(16));
assert.equal(Buffer.from(installation).toString("hex"),"4a".repeat(16));
const col=uuid(f.collection),grant=uuid(f.app.grant),client=hexBytes(f.app.client_pk,32),target=uuid(f.hosted.device);
const declarations=encode([col,owner,target,grant,installation,client,rootPK,policyPK,sha(genesis),sha(genesis),1]);
const db=new DatabaseSync(":memory:");
const storage={transactionSync(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}},sql:{exec(sql,...args){const st=db.prepare(sql);st.setReturnArrays(true);const columns=st.columns().map(c=>c.name),rows=st.all(...args.map(a=>a instanceof ArrayBuffer?new Uint8Array(a):a));return {columnNames:columns,one:()=>Object.fromEntries(columns.map((c,i)=>[c,rows[0][i]])),*raw(){for(const r of rows)yield r.map(v=>v instanceof Uint8Array?v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength):v);}};}}};
const openConfig=()=>encode(new Map([[0,col],[1,uuid(f.hosted.replica)],[2,target],[3,[rootPK]],[4,f.hosted.signers.map(uuid)],[5,hexBytes(f.hosted.sign_sk,32)],[6,hexBytes(f.hosted.kem_sk,32)],[8,pins],[9,genesis],[10,sha(genesis)]]));
const e=new Engine(storage);let handle,warm,warmHandle;
try {
  e.open(openConfig());
  assert.ok(e.noiseKey(hexBytes(f.hosted.noise_sk,32)));assert.ok(e.logBind());
  const prologue=new Uint8Array(64);prologue.set(Buffer.from("mdbase/v1/client"));prologue.set(col,16);prologue.set(grant,32);prologue.set(target,48);
  // Exact production app prologue is checked below against the native parser.
  handle=e.noiseStart(prologue);assert.ok(handle);
  const initiator=new IkInitiator({prologue,staticKey:keyPairFromSecret(hexBytes(f.app.client_sk,32)),remoteStatic:hexBytes(f.app.hosted_noise_pk,32)});
  const m1=await initiator.writeMessage1(new Uint8Array());const read1=e.noiseRead1(handle,m1);assert.ok(read1);assert.deepEqual(read1.peer,client);m1.fill(0);
  assert.equal(e.pitrAppQuery(handle,declarations),null,"M1 cannot replace FULL native admission");
  const head=items.length,lastChain=chain(items.at(-1));
  const pumpNative=engine=>{for(let turn=0;turn<64;turn++){
    const calls=engine.logCalls();if(!calls.length)break;
    for(const c of calls){const call=decode(c.frame),method=call.get(2),p=call.get(3);let result;
      if(method==="head")result=new Map([[0,head],[1,lastChain],[2,1]]);
      else if(method==="read")result=new Map([[0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>i>p.get(1)&&(p.get(3)!==1||[2,3,4,5,6].includes(decode(b).get(1))))],[1,head],[2,lastChain],[3,1],[4,false],[6,false]]);
      else throw Error(`unexpected fixture log method ${method}`);
      engine.logReply(c.id,encode(new Map([[0,1],[1,call.get(1)],[2,result]])));c.frame.fill(0);
    }
    if(turn===63)throw Error("bounded fixture pump exhausted");
  }};
  pumpNative(e);
  const beforeHead=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const beforeChanges=db.prepare("SELECT total_changes() n").get().n;
  if(process.env.PITR_APP_QUERY_DIAGNOSTICS==="1")console.log(JSON.stringify({publicAdmission:e.admission(),serving:e.serving(),wake:String(e.wakeInstance()),grant:e.grantOk(grant,client),decl:decode(declarations),tailColumns:db.prepare("PRAGMA table_info(st_tail)").all(),tailRows:db.prepare("SELECT COUNT(*) count FROM st_tail").all()},(_,v)=>v instanceof Map?Array.from(v.entries()):v instanceof Uint8Array?Buffer.from(v).toString("hex"):typeof v==="bigint"?String(v):v));
  const query=e.pitrAppQuery(handle,declarations);assert.ok(query,"FULL real native context + own Noise handle + exact originals");
  assert.equal(query.collection,f.collection);assert.equal(query.grant,f.app.grant);assert.equal(query.clientPublicKey,f.app.client_pk);assert.equal(query.genesisSha256,Buffer.from(sha(genesis)).toString("hex"));
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),beforeHead);
  assert.equal(db.prepare("SELECT total_changes() n").get().n,beforeChanges,"observation is read-only");
  const m2=e.noiseWrite2(handle,new Uint8Array());assert.ok(m2);await initiator.readMessage2(m2);m2.fill(0);assert.deepEqual(e.pitrAppQuery(handle,declarations),query);
  // Bounded hermetic transport/session lifecycle coverage, NOT the managed
  // all-offline/revoke/100k whole-isolate or private app RPC qualification.
  const seenHandles=new Set([handle]),emptyAd=new Uint8Array(),transportSessions=64;
  for(let i=0;i<transportSessions;i++){
    const h=e.noiseStart(prologue);assert.ok(h);assert.equal(seenHandles.has(h),false);seenHandles.add(h);
    try{
      const peer=new IkInitiator({prologue,staticKey:keyPairFromSecret(hexBytes(f.app.client_sk,32)),remoteStatic:hexBytes(f.app.hosted_noise_pk,32)});
      const first=await peer.writeMessage1(new Uint8Array());const read=e.noiseRead1(h,first);first.fill(0);assert.ok(read);assert.deepEqual(read.peer,client);
      assert.deepEqual(e.pitrAppQuery(h,declarations),query);
      const second=e.noiseWrite2(h,new Uint8Array());assert.ok(second);const {transport}=await peer.readMessage2(second);second.fill(0);
      const plain=new TextEncoder().encode(`PUBLIC synthetic transport ${i}`);
      const encrypted=transport.send.encrypt(emptyAd,plain);const opened=e.noiseOpen(h,encrypted);assert.ok(opened);assert.deepEqual(opened,plain);opened.fill(0);
      const reply=e.noiseSeal(h,plain.slice());assert.ok(reply);const decoded=transport.recv.decrypt(emptyAd,reply);assert.deepEqual(decoded,plain);decoded.fill(0);reply.fill(0);
      assert.deepEqual(e.pitrAppQuery(h,declarations),query);
      if(i%2===0)e.noiseDrop(h);
      else{
        const invalid=transport.send.encrypt(emptyAd,plain);invalid[invalid.length-1]^=1;
        assert.equal(e.noiseOpen(h,invalid),null,"decryption fault must refuse and discard this native session");
      }
      plain.fill(0);assert.equal(e.pitrAppQuery(h,declarations),null);
      assert.deepEqual(e.pitrAppQuery(handle,declarations),query,"other actual authenticated session remains isolated");
    }finally{e.noiseDrop(h);}
  }
  const deleted="dddddddd-dddd-4ddd-addd-dddddddddddd",binding={run:PITR_RUN,active:f.collection,deleted,codeConfigSha256:"aa".repeat(32),members:[...[f.collection,deleted].map((collection,i)=>({kind:"log",collection,namespace:"01".repeat(16),object:`0${i+1}`.repeat(32)})),{kind:"registry",collection:"00000000-0000-0000-0000-000000000000",namespace:"01".repeat(16),object:"03".repeat(32)},...[f.collection,deleted].map((collection,i)=>({kind:"hosted",collection,namespace:"02".repeat(16),object:`0${i+4}`.repeat(32)}))]};
  let points=0;const cp=(after=()=>{},reply=req=>Response.json({...req,current:true,checkedAt:1000}))=>new ControlClient({url:"https://connect-lab.mdbase.dev",token:"h".repeat(40),pitr:{binding,token:"p".repeat(40)}},async(url,opts)=>{points++;assert.equal(new URL(url).pathname,"/internal/v1/next/lab-pitr/current-app-grant");const req=JSON.parse(opts.body);assert.deepEqual(req,{run:PITR_RUN,...query});after();return reply(req);},()=>1000);
  const refused=/pitr_app_current_not_established/;
  assert.equal(await e.assertPitrAppCurrent(handle,declarations,cp(),new AbortController().signal),undefined);
  // These are actual native observations + production ControlClient refusal
  // paths with a fake CP transport, not provider outage/liveness qualification.
  for(const reply of [req=>Response.json({...req,current:false,checkedAt:1000}),()=>new Response("unavailable",{status:503}),()=>{throw new TypeError("synthetic transport unavailable");}]){
    await assert.rejects(e.assertPitrAppCurrent(handle,declarations,cp(()=>{},reply),new AbortController().signal),refused);
    assert.deepEqual(e.pitrAppQuery(handle,declarations),query,"CP refusal must not become a positive current point or mutate native history");
  }
  const aborted=new AbortController();
  await assert.rejects(e.assertPitrAppCurrent(handle,declarations,cp(()=>aborted.abort()),aborted.signal),refused);
  assert.deepEqual(e.pitrAppQuery(handle,declarations),query);
  const changed=declarations.slice();
  await assert.rejects(e.assertPitrAppCurrent(handle,changed,cp(()=>changed[changed.length-1]^=1),new AbortController().signal),refused);
  assert.deepEqual(e.pitrAppQuery(handle,declarations),query);
  await assert.rejects(e.assertPitrAppCurrent(handle,declarations,cp(()=>e.noiseDrop(handle)),new AbortController().signal),refused);
  assert.equal(e.pitrAppQuery(handle,declarations),null);
  // A separate genuine M1 makes retirement an independent native-context drift
  // case rather than reusing the already dropped handle's negative result.
  handle=e.noiseStart(prologue);assert.ok(handle);
  const fresh=new IkInitiator({prologue,staticKey:keyPairFromSecret(hexBytes(f.app.client_sk,32)),remoteStatic:hexBytes(f.app.hosted_noise_pk,32)});
  const freshM1=await fresh.writeMessage1(new Uint8Array());const freshRead=e.noiseRead1(handle,freshM1);freshM1.fill(0);assert.ok(freshRead);assert.deepEqual(freshRead.peer,client);
  assert.deepEqual(e.pitrAppQuery(handle,declarations),query);
  await assert.rejects(e.assertPitrAppCurrent(handle,declarations,cp(()=>e.logRetire()),new AbortController().signal),refused);
  assert.equal(e.serving(),false);assert.equal(e.pitrAppQuery(handle,declarations),null);assert.equal(points,8);
  assert.equal(db.prepare("SELECT total_changes() n").get().n,beforeChanges,"all point/refusal/drift paths stay SQL read-only");
  // Independent actual WASM instance over the SAME persisted SQLite. Hints and
  // projected policy must not reconstruct an observation before native replay.
  warm=new Engine(storage);warm.open(openConfig());
  assert.ok(warm.noiseKey(hexBytes(f.hosted.noise_sk,32)));assert.ok(warm.logBind());
  warmHandle=warm.noiseStart(prologue);assert.ok(warmHandle);
  const warmPeer=new IkInitiator({prologue,staticKey:keyPairFromSecret(hexBytes(f.app.client_sk,32)),remoteStatic:hexBytes(f.app.hosted_noise_pk,32)});
  const warmM1=await warmPeer.writeMessage1(new Uint8Array());assert.deepEqual(warm.noiseRead1(warmHandle,warmM1).peer,client);warmM1.fill(0);
  assert.equal(warm.pitrAppQuery(warmHandle,declarations),null,"warm persisted hints/projections alone are not accepted originals");
  pumpNative(warm);
  const warmChanges=db.prepare("SELECT total_changes() n").get().n;
  assert.deepEqual(warm.pitrAppQuery(warmHandle,declarations),query,"actual complete native semantic/key replay + settled healthy hint commit");
  const warmM2=warm.noiseWrite2(warmHandle,new Uint8Array());assert.ok(warmM2);await warmPeer.readMessage2(warmM2);warmM2.fill(0);
  assert.deepEqual(warm.pitrAppQuery(warmHandle,declarations),query);
  assert.equal(db.prepare("SELECT total_changes() n").get().n,warmChanges,"warm observations are SQL read-only after replay");
  // This run-owned in-memory cache deliberately loses ALL complete raw rows.
  // The FULL projection/previous genuine observation cannot substitute them.
  db.exec("DELETE FROM st_tail");const prunedChanges=db.prepare("SELECT total_changes() n").get().n;
  assert.equal(warm.serving(),true,"missing originals do not relabel native FULL");
  assert.equal(warm.pitrAppQuery(warmHandle,declarations),null,"pruned complete originals refuse; hints are not recovery authority");
  assert.equal(db.prepare("SELECT total_changes() n").get().n,prunedChanges,"prune refusal is SQL read-only");
  console.log(JSON.stringify({actualProductionWasm:true,actualSQLite:true,actualSdkNoise:true,actualCp:false,fixture:"PUBLIC fixed synthetic app",fixtureSourceHead:manifest.sourceHead,fixtureSha256:manifest.sha256,positiveQuery:true,transportSessions,nativeDecryptFaultClearsObservation:true,cpDenyHttpAndTransportRefused:true,abortAndInputDriftRefused:true,postAwaitDroppedHandleRefused:true,postAwaitRetiredNativeRefused:true,cpPoints:points,warmHintsRefusedBeforeNativeReplay:true,warmActualNativeReplayQualified:true,prunedOriginalsRefusedDespiteFull:true,doRuntimeQualified:false,preKeyHistoryPhaseOrEffectLease:false}));
} finally {if(handle)e.noiseDrop(handle);if(warmHandle)warm.noiseDrop(warmHandle);db.close();}
