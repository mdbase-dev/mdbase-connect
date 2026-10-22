// Actual production WASM/SQLite/Engine/compiled-factory provenance, PUBLIC
// synthetic keys and fake log only. No CPP/DO/physical/H1/provider operation.
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash,createPrivateKey,createPublicKey,verify} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";
import {decode as publicDecode} from "../../../packages/sdk/src/cbor.ts";
const bin=process.env.HOSTED_WASM,input=process.env.PITR_APP_FIXTURE;
if(!bin||!input)throw Error("fresh HOSTED_WASM and PUBLIC PITR_APP_FIXTURE required");
const wasm=await readFile(resolve(bin));const fb=await readFile(resolve(input));assert.ok(fb.length<=128*1024);
const manifest=JSON.parse(await readFile(resolve(input.replace(/\.json$/,".manifest.json")),"utf8"));
assert.equal(manifest.bytes,fb.length);assert.equal(manifest.sha256,createHash("sha256").update(fb).digest("hex"));assert.equal(manifest.publicFixedTestValuesOnly,true);
const f=JSON.parse(fb);assert.equal(f.collection,"0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e");
for(const [k,v]of [["sign_sk","43"],["kem_sk","44"],["noise_sk","47"]])assert.equal(f.hosted[k],v.repeat(32));
const declared=JSON.parse(await readFile(new URL("./fixtures/public-genesis.json",import.meta.url),"utf8"));
// TEST-only independently declared PUBLIC release literal; never CP/SQL trust.
const declaredRootHex=Buffer.from(publicDecode(new Uint8Array(Buffer.from(declared.pins,"base64")))[0][0][1]).toString("hex");
const releaseSource=`export function appReleaseTrust(){return {schema:"mdbn-app-trust/release/1",environment:"lab",cpOrigin:"https://connect-lab.mdbase.dev",logOrigin:"https://log.test",trustedRoots:[Uint8Array.from(Buffer.from('${declaredRootHex}','hex'))],policyPins:Uint8Array.from(Buffer.from('${declared.pins}','base64'))};}`;
const compiled=await build({stdin:{contents:'export {Engine,encode,decode} from "../src/engine.ts";export {ControlClient} from "../src/control.ts";export {productionParts,ownedCppControlOrigin} from "../src/factory.ts";',resolveDir:new URL(".",import.meta.url).pathname},bundle:true,write:false,format:"esm",platform:"node",plugins:[{name:"public-native-fixture",setup(b){
 b.onResolve({filter:/hosted\.wasm$/},()=>({path:"actual-wasm",namespace:"cpp-native"}));
 b.onLoad({filter:/.*/,namespace:"cpp-native"},()=>({contents:`export default new WebAssembly.Module(Uint8Array.from(Buffer.from('${wasm.toString("base64")}','base64')));`}));
 b.onResolve({filter:/^#hosted-release-trust$/},()=>({path:"fixed-public-release",namespace:"cpp-test-only"}));
 b.onLoad({filter:/.*/,namespace:"cpp-test-only"},()=>({contents:releaseSource}));
}}]});
const {Engine,encode,decode,ControlClient,productionParts,ownedCppControlOrigin}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const bytes=s=>new Uint8Array(Buffer.from(s,"hex"));const uuid=s=>bytes(s.replaceAll("-",""));
const sha=b=>new Uint8Array(createHash("sha256").update(b).digest());
const hash=(tag,b)=>sha(Buffer.concat([Buffer.from([Buffer.byteLength(tag)]),Buffer.from(tag),b]));
const pins=new Uint8Array(Buffer.from(declared.pins,"base64")),trusted=decode(pins),rootPK=trusted[0][0][1];
assert.equal(f.root_pk,Buffer.from(rootPK).toString("hex"));
const items=f.items.map(bytes);assert.equal(items.length,2);const genesis=items[0];
const config=()=>encode(new Map([[0,uuid(f.collection)],[1,uuid(f.hosted.replica)],[2,uuid(f.hosted.device)],[3,[rootPK]],[4,f.hosted.signers.map(uuid)],[5,bytes(f.hosted.sign_sk)],[6,bytes(f.hosted.kem_sk)],[8,pins],[9,genesis],[10,sha(genesis)]]));
const db=new DatabaseSync(":memory:");
const storage={transactionSync(fn){db.exec("BEGIN");try{const r=fn();db.exec("COMMIT");return r;}catch(e){db.exec("ROLLBACK");throw e;}},sql:{exec(sql,...args){const st=db.prepare(sql);st.setReturnArrays(true);const columns=st.columns().map(c=>c.name),rows=st.all(...args.map(a=>a instanceof ArrayBuffer?new Uint8Array(a):a));return {columnNames:columns,one:()=>Object.fromEntries(columns.map((c,i)=>[c,rows[0][i]])),*raw(){for(const r of rows)yield r.map(v=>v instanceof Uint8Array?v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength):v);}};}}};
const origin="https://connect-lab.mdbase.dev";
const env={KMS_KEY_ARN:"arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111",AWS_REGION:"eu-west-1",AWS_ACCESS_KEY_ID:"AKIDEXAMPLE",AWS_SECRET_ACCESS_KEY:"s".repeat(40),KMS_ENVIRONMENT:"lab",KMS_COLLECTIONS:f.collection,LOG_URL:"https://log.test",CP_URL:origin,CP_INBOUND_TOKEN:"t".repeat(40),HOSTED_SIGNERS:f.hosted.signers.join(",")};
let network=0;const control=productionParts(env,async()=>{network++;throw Error("no external request permitted");}).control;
assert.equal(ownedCppControlOrigin(control),origin);const ordinary=new ControlClient({url:origin,token:"t".repeat(40)});assert.equal(ownedCppControlOrigin(ordinary),null);
let e,warm,normal;
const pump=engine=>{assert.ok(engine.logBind());for(let turn=0;turn<64;turn++){let calls=engine.logCalls();if(!calls.length)return;for(const c of calls){const call=decode(c.frame),method=call.get(2),p=call.get(3);let result;
 if(method==="head")result=new Map([[0,items.length],[1,hash("mdbase/v1/chain",items.at(-1))],[2,1]]);
 else if(method==="read")result=new Map([[0,items.map((b,i)=>[i+1,b]).filter(([i,b])=>i>p.get(1)&&(p.get(3)!==1||[2,3,4,5,6].includes(decode(b).get(1))))],[1,items.length],[2,hash("mdbase/v1/chain",items.at(-1))],[3,1],[4,false],[6,false]]);
 else throw Error(`unexpected fake log method ${method}`);
 engine.logReply(c.id,encode(new Map([[0,1],[1,call.get(1)],[2,result]])));c.frame.fill(0);
 }}throw Error("bounded fake log exhausted");};
try {
 const rejected=new Engine(storage),bad=config();const before=db.prepare("SELECT total_changes() n").get().n;
 assert.throws(()=>rejected.openForCppClaim(bad,ordinary),/owned_control/);assert.ok(bad.every(v=>v===0));assert.equal(db.prepare("SELECT total_changes() n").get().n,before,"fake role cannot reach native SQL/open");
 e=new Engine(storage);e.openForCppClaim(config(),control);assert.throws(()=>e.beginCppClaim(),/refused/);pump(e);
 const changes=db.prepare("SELECT total_changes() n").get().n;
 let t=e.beginCppClaim();assert.ok(Object.isFrozen(t));assert.equal(t.collection,f.collection);assert.equal(t.device,f.hosted.device);
 assert.throws(()=>e.beginCppClaim(),/busy/);assert.throws(()=>e.signCppClaimChallenge({...t},new Uint8Array(32)),/refused/);
 e.assertCppClaimCurrent(t);const challenge=new Uint8Array(32).fill(0x55);const sig=e.signCppClaimChallenge(t,challenge);assert.equal(sig.length,64);assert.ok(challenge.every(v=>v===0x55));
 const xpublic=secret=>new Uint8Array(createPublicKey(createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b656e04220420","hex"),bytes(secret)]),format:"der",type:"pkcs8"})).export({format:"der",type:"spki"}).subarray(-32));
 const fields=[1,origin,"POST",`/internal/v1/next/migration/collections/${f.collection}/claim/read`,uuid(f.collection),uuid(f.hosted.device),trusted[0][0][0],bytes(f.hosted.sign_pk),xpublic(f.hosted.kem_sk),xpublic(f.hosted.noise_sk),challenge];
 const pk=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),bytes(f.hosted.sign_pk)]),format:"der",type:"spki"});
 assert.ok(verify(null,hash("mdbase/v1/cp-hosted-migration-claim-read",encode(fields)),pk,sig),"actual ABI native signature, exact native/configured fields");
 for(let i=0;i<fields.length;i++){const changed=fields.slice();changed[i]=i===0?2:i<4?"wrong":new Uint8Array(i<7?16:32).fill(0x99);assert.equal(verify(null,hash("mdbase/v1/cp-hosted-migration-claim-read",encode(changed)),pk,sig),false,`signed field ${i}`);}
 assert.throws(()=>e.signCppClaimChallenge(t,challenge),/refused/);e.assertCppClaimCurrent(t);
 // Retained point survives both synthetic awaits, but is never CPP permission.
 await Promise.resolve();e.assertCppClaimCurrent(t);e.finishCppClaim(t);assert.throws(()=>e.assertCppClaimCurrent(t),/refused/);
 const successor=e.beginCppClaim();e.finishCppClaim(t);e.assertCppClaimCurrent(successor);e.finishCppClaim(successor);
 for(const size of [0,31,33]){const x=e.beginCppClaim();assert.throws(()=>e.signCppClaimChallenge(x,new Uint8Array(size)),/refused/);assert.throws(()=>e.assertCppClaimCurrent(x),/refused/);e.finishCppClaim(x);}
 // Exercise the actual native single slot/numeric/once ABI, not just JS guards.
 const api=e.ex;const raw=e.takeDecoded(api.hd_cpp_claim_begin());assert.equal(raw.length,3);const h=raw[0];
 assert.equal(e.takeDecoded(api.hd_cpp_claim_begin()),null,"native busy begin cannot overwrite");
 for(const badHandle of [NaN,Infinity,-1,0,h+0.5,2**53]){assert.equal(api.hd_cpp_claim_current(badHandle),0);api.hd_cpp_claim_finish(badHandle);assert.equal(e.take(api.hd_cpp_claim_sign(badHandle,...e.put(new Uint8Array(32)))).length,0);}
 assert.equal(api.hd_cpp_claim_current(h),1);assert.equal(e.take(api.hd_cpp_claim_sign(h,...e.put(new Uint8Array(32)))).length,64);assert.equal(e.take(api.hd_cpp_claim_sign(h,...e.put(new Uint8Array(32)))).length,0);
 api.hd_cpp_claim_finish(h);assert.equal(api.hd_cpp_claim_current(h),0);
 const next=e.takeDecoded(api.hd_cpp_claim_begin());assert.ok(next[0]>h);api.hd_cpp_claim_finish(h);assert.equal(api.hd_cpp_claim_current(next[0]),1);
 assert.equal(e.take(api.hd_cpp_claim_sign(next[0],...e.put(new Uint8Array(31)))).length,0);assert.equal(api.hd_cpp_claim_current(next[0]),0,"native malformed attempt closes exact slot");
 assert.equal(db.prepare("SELECT total_changes() n").get().n,changes,"begin/assert/sign/finish write no SQL");
 // Actual native Driver/SqlSpill journal, independent of CPP observation tickets.
 const textUuid=b=>Buffer.from(b).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,"$1-$2-$3-$4-$5");
 const owner=textUuid(decode(decode(genesis).get(11)).get(3).find(op=>op.get(0)===1).get(1));
 const runClaim={schema:"mdbase-migration-claim/1",collection_id:f.collection,owner_account:owner,started_us:"10413792000000001",target:{runtime:"shadow",root_key_id:Buffer.from(trusted[0][0][0]).toString("hex"),hosted:{device_id:f.hosted.device,sign_pk:f.hosted.sign_pk,kem_pk:Buffer.from(xpublic(f.hosted.kem_sk)).toString("hex"),noise_pk:Buffer.from(xpublic(f.hosted.noise_sk)).toString("hex")}}};
 const runCpp=e.beginCppClaim();e.signCppClaimChallenge(runCpp,challenge);
 assert.throws(()=>e.openMigrationDriver(runCpp,{...runClaim,owner_account:"99999999-9999-4999-8999-999999999999"}),/run_refused/,"actual accepted Genesis owner, not a supplied owner flag");
 for(const key of ["root_key_id","sign_pk","kem_pk","noise_pk"]){const changed={...runClaim,target:{...runClaim.target,hosted:{...runClaim.target.hosted}}};if(key==="root_key_id")changed.target.root_key_id="99".repeat(16);else changed.target.hosted[key]="99".repeat(32);assert.throws(()=>e.openMigrationDriver(runCpp,changed),/run_refused/,`actual native accepted CPP target field ${key}`);}
 e.openMigrationDriver(runCpp,runClaim);
 const pending=e.beginMigrationPending();assert.ok(Object.isFrozen(pending));assert.equal(pending.collection,f.collection);assert.equal(pending.sequence,1);assert.equal(pending.kind,0);
 e.assertMigrationPendingCurrent(pending);assert.throws(()=>e.assertMigrationPendingCurrent({...pending}),/pending_refused/);
 const physical=e.beginMigrationPhysical(pending);e.assertMigrationPhysicalCurrent(physical);assert.throws(()=>e.assertMigrationPhysicalCurrent({...physical}),/physical_unknown/);assert.throws(()=>e.beginMigrationPhysical(pending),/physical_unknown/);e.closeMigrationPhysical(physical);assert.throws(()=>e.assertMigrationPhysicalCurrent(physical),/physical_unknown/);
 const nextPhysical=e.beginMigrationPhysical(pending);e.closeMigrationPhysical(physical);e.assertMigrationPhysicalCurrent(nextPhysical);e.closeMigrationPhysical(nextPhysical); // No synthetic positive ACK: only actual-host tests may finish after real sync.
 assert.equal(db.prepare("SELECT count(*) n FROM mig_native_action WHERE settled=0").get().n,1);
 assert.throws(()=>e.beginMigrationPending(),/pending_unknown/);assert.throws(()=>e.recordMigrationKeyingWait(pending),/settlement_unknown/,"H0 is not H1 and cannot invent a hold");
 assert.throws(()=>e.openMigrationDriver(runCpp,{...runClaim,started_us:"10413792000000002"}),/run_refused/,"exact native run binding never renews");
 e.finishMigrationPending(pending);assert.equal(db.prepare("SELECT settled FROM mig_native_action WHERE seq=1").get().settled,0);
 assert.throws(()=>e.beginMigrationPending(),/pending_refused/,"RAM cleanup cannot abandon/retry the original effect");
 e.finishCppClaim(runCpp);
 console.log("PASS actual native Driver journal/persist-before-effect/immutable owner+microsecond run/opaque pending/UNKNOWN cleanup; physical ACK/effect/H1 unqualified");
 t=e.beginCppClaim();await Promise.resolve();e.logRetire();assert.throws(()=>e.signCppClaimChallenge(t,challenge),/refused/);e.finishCppClaim(t);
 warm=new Engine(storage);warm.openForCppClaim(config(),control);assert.throws(()=>warm.beginCppClaim(),/refused/,"warm persisted hints alone not native acceptance");assert.throws(()=>warm.assertCppClaimCurrent(t),/refused/);pump(warm);
 const wt=warm.beginCppClaim();assert.throws(()=>e.signCppClaimChallenge(wt,challenge),/refused/);assert.equal(warm.signCppClaimChallenge(wt,challenge).length,64);warm.finishCppClaim(wt);
 const pruning=warm.beginCppClaim();assert.equal(db.prepare("DELETE FROM st_tail WHERE seq=?").run(Buffer.from("0000000000000001","hex")).changes,1,"actual retained seq key is lossless big-endian BLOB8");assert.throws(()=>warm.signCppClaimChallenge(pruning,challenge),/refused/);warm.finishCppClaim(pruning);
 normal=new Engine(storage);normal.open(config());pump(normal);assert.throws(()=>normal.beginCppClaim(),/refused/,"ordinary open never acquires CPP signer");
 const repeat=config();assert.throws(()=>warm.openForCppClaim(repeat,control),/already opened/);assert.ok(repeat.every(v=>v===0));
 const rawOpen=(engine,audience)=>{const c=config(),a=new TextEncoder().encode(audience);try{return new TextDecoder().decode(engine.take(engine.ex.hd_open_cpp_claim(...engine.put(c),...engine.put(a))));}finally{c.fill(0);a.fill(0);}};
 assert.equal(rawOpen(warm,origin),"CPP configuration refused","native CPP initialization cannot be repeated");
 assert.equal(rawOpen(normal,origin),"CPP configuration refused","ordinary native open cannot become a CPP signer");
 const malformed=new Engine(storage),writes=db.prepare("SELECT total_changes() n").get().n;
 assert.equal(rawOpen(malformed,"https://UPPER.test"),"CPP configuration refused");assert.equal(rawOpen(malformed,origin),"CPP configuration refused","failed native CPP initialization burns retry");assert.equal(db.prepare("SELECT total_changes() n").get().n,writes);assert.equal(network,0);
 console.log("PASS actual production CPP bridge/SQLite/factory: signature,11 fields,cold/default/brand/ticket/singleflight/once/malformed/await-retire/warm/prune/readonly; CP+physical+H1 unqualified");
} finally {sigCleanup();db.close();}
function sigCleanup(){e?.logRetire();warm?.logRetire();normal?.logRetire();}
