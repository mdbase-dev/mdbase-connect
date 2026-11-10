// Own local Chromium/profile/public metadata fixture ONLY. No LAB/account/CP
// registration/native policy/production key provider/Saved acceptance claim.
// Optional argv[2]: the actual app-runtime.wasm. It is then loaded in this same
// Chromium worker to check the account-key fetch proof export on the real
// binary (present, and signing nothing for an unopened runtime). The proof
// itself is verified on the real binary by scripts/app-wasm-smoke.mjs; no
// browser unlock is qualified here.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const artifact = process.argv[2] ? await readFile(resolve(process.argv[2])) : null;
const out = resolve("target/private-persistence-smoke"), profile = resolve(out, `profile-${process.pid}`); await mkdir(out, { recursive: true });
const source = `
import { AppWebPrivateBootstrapPersistence, APP_PRIVATE_BOOTSTRAP_CIPHER_MAX } from "./packages/sdk/src/app-host/private-persistence.ts";
import { AppIndexedDbPrivateBootstrapStore } from "./packages/sdk/src/app-host/private-persistence-idb.ts";
const check = value => { if (!value) throw Error("public fixture assertion failed"); };
const source = () => ({ accountId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connectorId:"66666666-6666-6666-6666-666666666666", deviceId:"44444444-4444-4444-4444-444444444444", installationId:"88888888-8888-8888-8888-888888888888", collection:"22222222-2222-2222-2222-222222222222", purpose:"create", approvalMode:"password-ak1", cpOrigin:"https://cp.example", logOrigin:"https://log.example", rootPublicKey:new Uint8Array(32).fill(9), isCurrent:()=>true, connectorBearer:async()=>{throw Error("no network auth in fixture");} });
const receipt = p => ({connectorId:p.connectorId,deviceId:p.deviceId,installationId:p.installationId,signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3)});
async function fixtureKey(mode) {
 const db=await new Promise((yes,no)=>{const r=indexedDB.open("private-public-fixture-kek",1);r.onupgradeneeded=()=>{if(mode!=="fresh"){r.transaction.abort();return;}r.result.createObjectStore("key");};r.onsuccess=()=>yes(r.result);r.onerror=()=>no(Error("missing fixture key"));});
 try {
  const key=await new Promise((yes,no)=>{const tx=db.transaction("key","readonly"),r=tx.objectStore("key").get("kek");tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(Error("key read failed"));});
  if(key){check(mode==="existing"&&!key.extractable);return key;}
  check(mode==="fresh");const made=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  await new Promise((yes,no)=>{const tx=db.transaction("key","readwrite"),s=tx.objectStore("key"),r=s.get("kek");r.onsuccess=()=>{if(r.result!==undefined)tx.abort();else s.put(made,"kek");};tx.oncomplete=yes;tx.onabort=()=>no(Error("uncertain fixture key write"));});return made;
 }finally{db.close();}
}
self.onmessage=async e=>{let store;try{
 if(e.data.phase==="runtime"){
  // Actual app runtime artifact in this browser. Unopened: no key, connector or
  // collection, so the one account-key proof export must sign nothing and must
  // not call the host.
  const module=await WebAssembly.compileStreaming(fetch("/app-runtime.wasm")),names=WebAssembly.Module.exports(module).map(x=>x.name);
  check(names.includes("rt_app_account_key_fetch_sign")&&names.includes("rt_app_cp_log_token_sign"));
  // The only account-key signing export; no put/strict/report or digest signer.
  check(names.filter(n=>/account_key.*sign|sign.*account_key|sign_digest/.test(n)).join()==="rt_app_account_key_fetch_sign");
  const env={};for(const i of WebAssembly.Module.imports(module)){check(i.module==="env"&&i.kind==="function");env[i.name]=()=>{throw Error("unopened fixture runtime called the host");};}
  const x=(await WebAssembly.instantiate(module,{env})).exports;
  const input=new Uint8Array(54);input.set([0xa2,0,0x58,0x20]);input.fill(0x31,4,36);input.set([1,0x50],36);input.fill(0x41,38);
  const at=x.alloc(input.length);new Uint8Array(x.memory.buffer,at,input.length).set(input);
  check((BigInt.asUintN(64,x.rt_app_account_key_fetch_sign(at,input.length))&0xffffffffn)===0n);
  self.postMessage({actualAppWasmInChromium:true,fetchProofExport:true,unopenedRuntimeSignsNothing:true});return;
 }
 const p=source(),signal=AbortSignal.timeout(15000),options={source:p,origin:location.origin,mode:e.data.mode,signal};
 const key=await fixtureKey(e.data.mode);let exported=false;try{await crypto.subtle.exportKey("raw",key);exported=true;}catch{}check(!exported);
 const noise={privateEnrolPending:async()=>{throw Error("wrong fixture purpose");},privateEnrolAcknowledged:async()=>{throw Error("wrong fixture purpose");}};
 if(e.data.phase==="cas"){
  p.collection="99999999-9999-9999-9999-999999999999";const a=await AppIndexedDbPrivateBootstrapStore.open({...options,mode:"fresh"}),b=await AppIndexedDbPrivateBootstrapStore.open({...options,mode:"fresh"});
  try{const result=await Promise.all([a.compareAndSet(null,Uint8Array.of(7),{signal}),b.compareAndSet(null,Uint8Array.of(8),{signal})]);check(result.filter(Boolean).length===1);const kept=await a.read({signal});check(kept[0]===(result[0]?7:8));check(await a.compareAndSet(Uint8Array.of(99),Uint8Array.of(10),{signal})===false);
   let oversized=false;try{await a.compareAndSet(kept,new Uint8Array(APP_PRIVATE_BOOTSTRAP_CIPHER_MAX+1),{signal});}catch{oversized=true;}check(oversized);check((await a.read({signal}))[0]===kept[0]);p.isCurrent=()=>false;let stale=false;try{await a.read({signal});}catch{stale=true;}check(stale);self.postMessage({atomicCas:true,boundsAndOriginalOwner:true});
  }finally{a.close();b.close();}return;
 }
 if(e.data.phase==="refusals"){
  let fresh=false,missing=false,origin=false;try{await AppIndexedDbPrivateBootstrapStore.open({...options,mode:"fresh"});}catch{fresh=true;}try{await AppIndexedDbPrivateBootstrapStore.open({...options,source:{...p,collection:"33333333-3333-3333-3333-333333333333"}});}catch{missing=true;}try{await AppIndexedDbPrivateBootstrapStore.open({...options,origin:"https://foreign.invalid"});}catch{origin=true;}check(fresh&&missing&&origin);self.postMessage({existingFreshRefused:true,missingExistingRefused:true,foreignOriginRefused:true});return;
 }
 if(e.data.phase==="enrol"||e.data.phase==="enrol-reopen"){
  // An installation device joining an EXISTING Private collection (purpose "enrol"):
  // the record an enrolled, not yet keyed device reopens from. No native runtime,
  // CP, log or account key here; the unlock step is not part of this fixture.
  p.collection="55555555-5555-5555-5555-555555555555";p.purpose="enrol";
  const calls=[],enrolNoise={privateEnrolPending:async m=>{calls.push("pending:"+m.acknowledged);},privateEnrolAcknowledged:async m=>{calls.push("acknowledged:"+m.acknowledged);}};
  const marker=(acknowledged,fill)=>({...receipt(p),collection:p.collection,sasCommitment:new Uint8Array(32).fill(fill),acknowledged});
  const domain=new TextEncoder().encode("mdbase/v1/chain"),item=Uint8Array.of(2),input=new Uint8Array(1+domain.length+1);input[0]=domain.length;input.set(domain,1);input.set(item,1+domain.length);const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",input)),expectedGenesis="sha256:"+Array.from(hash,v=>v.toString(16).padStart(2,"0")).join("");
  const metadata={collection:p.collection,deviceId:p.deviceId,logOrigin:p.logOrigin,rootPublicKey:p.rootPublicKey,genesisItem:item,expectedGenesis,approval:"pending"};
  store=await AppIndexedDbPrivateBootstrapStore.open({...options,mode:e.data.phase==="enrol"?"fresh":"existing"});
  const vault=new AppWebPrivateBootstrapPersistence(p,receipt(p),key,store,enrolNoise);
  if(e.data.phase==="enrol"){
   check(await vault.restoredCompletion({signal})===null);
   let early=false;try{await vault.privateEnrolAcknowledged(marker(true,11),{signal});}catch{early=true;}check(early);
   await vault.privateEnrolPending(marker(false,11),{signal});check(await vault.restoredCompletion({signal})===null);
   let creator=false;try{await vault.completed({...metadata,approval:"creator"},{signal});}catch{creator=true;}check(creator);
   await vault.completed(metadata,{signal});await vault.privateEnrolAcknowledged(marker(true,11),{signal});
   check(calls.join()==="pending:false,acknowledged:true");
   self.postMessage({enrolMarkerBeforeRecord:true,pendingApprovalOnly:true,acknowledgedAfterCompletion:true});
  }else{
   const restored=await vault.restoredCompletion({signal});check(restored&&restored.approval==="pending"&&restored.expectedGenesis===expectedGenesis&&restored.genesisItem[0]===2&&restored.collection===p.collection);
   // Replaying the same operation is idempotent; another commitment or purpose is not this record.
   const before=await store.read({signal});await vault.privateEnrolPending(marker(false,11),{signal});const same=await store.read({signal});check(same.every((v,i)=>v===before[i]));
   let foreign=false;try{await vault.privateEnrolPending(marker(false,12),{signal});}catch{foreign=true;}check(foreign);
   let purpose=false;try{await new AppWebPrivateBootstrapPersistence({...p,purpose:"create"},receipt(p),key,store,enrolNoise).restoredCompletion({signal});}catch{purpose=true;}check(purpose);
   const after=await store.read({signal});check(after.every((v,i)=>v===before[i]));
   self.postMessage({enrolRestoredAfterRestart:true,replayIdempotent:true,foreignCommitmentRefused:true,createPurposeRefused:true});
  }
  return;
 }
 store=await AppIndexedDbPrivateBootstrapStore.open(options);
 const domain=new TextEncoder().encode("mdbase/v1/chain"),item=Uint8Array.of(1),input=new Uint8Array(1+domain.length+1);input[0]=domain.length;input.set(domain,1);input.set(item,1+domain.length);const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",input)),expectedGenesis="sha256:"+Array.from(hash,v=>v.toString(16).padStart(2,"0")).join("");
 const metadata={collection:p.collection,deviceId:p.deviceId,logOrigin:p.logOrigin,rootPublicKey:p.rootPublicKey,genesisItem:item,expectedGenesis,approval:"creator"};
 if(e.data.phase==="fresh"){
  let lost=false;const wrapped={read:o=>store.read(o),compareAndSet:async(expected,value,o)=>{const result=await store.compareAndSet(expected,value,o);if(lost)throw Error("committed response lost");return result;}};
  const vault=new AppWebPrivateBootstrapPersistence(p,receipt(p),key,wrapped,noise);await vault.pendingCreate({...receipt(p),collection:p.collection},{signal});lost=true;let uncertain=false;try{await vault.completed(metadata,{signal});}catch{uncertain=true;}check(uncertain);check((await store.read({signal})).length>0);self.postMessage({committedCompletionLoss:true,nonextractableFixtureKek:true});
 }else{
  const vault=new AppWebPrivateBootstrapPersistence(p,receipt(p),key,store,noise),restored=await vault.restoredCompletion({signal});check(restored&&restored.expectedGenesis===expectedGenesis&&restored.genesisItem[0]===1);restored.genesisItem.fill(0);check((await vault.restoredCompletion({signal})).genesisItem[0]===1);
  const before=await store.read({signal}),foreign={...p,rootPublicKey:new Uint8Array(32).fill(8)};let refused=false;try{await new AppWebPrivateBootstrapPersistence(foreign,receipt(p),key,store,noise).restoredCompletion({signal});}catch{refused=true;}check(refused);const after=await store.read({signal});check(after.every((v,i)=>v===before[i]));self.postMessage({sameCompletionProcessRestart:true,foreignTrustRefused:true,cipherPreserved:true});
 }
 }catch{self.postMessage({failure:true});}finally{store?.close();}};
`;
const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: "public-private-persistence-fixture.ts", loader: "ts" }, bundle: true, write: false, platform: "browser", format: "esm" });
const server = createServer((req, res) => { if (req.url === "/app-runtime.wasm" && artifact) { res.setHeader("content-type", "application/wasm"); res.end(artifact); } else if (req.url === "/worker.js") { res.setHeader("content-type", "text/javascript"); res.end(bundled.outputFiles[0].text); } else { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>public custody fixture</title>"); } });
await new Promise(yes => server.listen(0, "127.0.0.1", yes)); const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
 const run = async phase => { const page = await context.newPage(); try { await page.goto(origin); return await page.evaluate(phase => new Promise((yes, no) => { const worker = new Worker("/worker.js", { type: "module" }), timer = setTimeout(() => { worker.terminate(); no(Error("fixture timeout")); }, 20000); worker.onerror = () => { clearTimeout(timer); worker.terminate(); no(Error("fixture worker failed")); }; worker.onmessage = e => { clearTimeout(timer); worker.terminate(); yes(e.data); }; worker.postMessage({ phase, mode: phase === "fresh" ? "fresh" : "existing" }); }), phase); } finally { await page.close(); } };
 context = await playwright.chromium.launchPersistentContext(profile, { headless: true }); assert.deepEqual(await run("fresh"), { committedCompletionLoss: true, nonextractableFixtureKek: true }); assert.deepEqual(await run("enrol"), { enrolMarkerBeforeRecord: true, pendingApprovalOnly: true, acknowledgedAfterCompletion: true }); await context.close(); context = null;
 context = await playwright.chromium.launchPersistentContext(profile, { headless: true }); assert.deepEqual(await run("reopen"), { sameCompletionProcessRestart: true, foreignTrustRefused: true, cipherPreserved: true }); assert.deepEqual(await run("refusals"), { existingFreshRefused: true, missingExistingRefused: true, foreignOriginRefused: true }); assert.deepEqual(await run("cas"), { atomicCas: true, boundsAndOriginalOwner: true }); assert.deepEqual(await run("enrol-reopen"), { enrolRestoredAfterRestart: true, replayIdempotent: true, foreignCommitmentRefused: true, createPurposeRefused: true }); if (artifact) assert.deepEqual(await run("runtime"), { actualAppWasmInChromium: true, fetchProofExport: true, unopenedRuntimeSignsNothing: true });
 console.log(JSON.stringify({ actualIndexedDbAndAead: true, fullBrowserProcessRestart: true, lostCommittedCompletionPreserved: true, exactPublicScopeAndCas: true, privateEnrolRecordRestart: true, actualAppWasmFetchProofExport: Boolean(artifact), accountKeyUnlockQualified: false, fixtureKekOnly: true, nativePolicyQualified: false, productionSecretCustodyQualified: false, physicalDurabilityQualified: false, labTouched: false }));
} finally { await context?.close(); await new Promise(yes => server.close(yes)); }
