// Own local Chromium/profile/public metadata fixture ONLY. No LAB/account/CP
// registration/native policy/production key provider/Saved acceptance claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
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
 const p=source(),signal=AbortSignal.timeout(15000),options={source:p,origin:location.origin,allowLoopbackHttp:true,mode:e.data.mode,signal};
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
const server = createServer((req, res) => { if (req.url === "/worker.js") { res.setHeader("content-type", "text/javascript"); res.end(bundled.outputFiles[0].text); } else { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>public custody fixture</title>"); } });
await new Promise(yes => server.listen(0, "127.0.0.1", yes)); const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
 const run = async phase => { const page = await context.newPage(); try { await page.goto(origin); return await page.evaluate(phase => new Promise((yes, no) => { const worker = new Worker("/worker.js", { type: "module" }), timer = setTimeout(() => { worker.terminate(); no(Error("fixture timeout")); }, 20000); worker.onerror = () => { clearTimeout(timer); worker.terminate(); no(Error("fixture worker failed")); }; worker.onmessage = e => { clearTimeout(timer); worker.terminate(); yes(e.data); }; worker.postMessage({ phase, mode: phase === "fresh" ? "fresh" : "existing" }); }), phase); } finally { await page.close(); } };
 context = await playwright.chromium.launchPersistentContext(profile, { headless: true }); assert.deepEqual(await run("fresh"), { committedCompletionLoss: true, nonextractableFixtureKek: true }); await context.close(); context = null;
 context = await playwright.chromium.launchPersistentContext(profile, { headless: true }); assert.deepEqual(await run("reopen"), { sameCompletionProcessRestart: true, foreignTrustRefused: true, cipherPreserved: true }); assert.deepEqual(await run("refusals"), { existingFreshRefused: true, missingExistingRefused: true, foreignOriginRefused: true }); assert.deepEqual(await run("cas"), { atomicCas: true, boundsAndOriginalOwner: true });
 console.log(JSON.stringify({ actualIndexedDbAndAead: true, fullBrowserProcessRestart: true, lostCommittedCompletionPreserved: true, exactPublicScopeAndCas: true, fixtureKekOnly: true, nativePolicyQualified: false, productionSecretCustodyQualified: false, physicalDurabilityQualified: false, labTouched: false }));
} finally { await context?.close(); await new Promise(yes => server.close(yes)); }
