// Actual Chromium + owned persistent profile + actual SDK/WASM. Isolated public
// device fixture ONLY: no LAB, account, CP registration, provider or Saved claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const artifact=process.argv[2];if(!artifact)throw Error("explicit app artifact required");
const playwright=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:"playwright");
const out=resolve("target/noise-idb-smoke"),profile=resolve(out,`profile-${process.pid}`);await mkdir(out,{recursive:true});
const source=`
import { AppWasmRuntime,AppWebNoiseCustody,AppIndexedDbNoiseProtectedStore } from "./packages/sdk/src/app-host/index.ts";
import { AppWebPrivateBootstrapPersistence } from "./packages/sdk/src/app-host/private-persistence.ts";
import { AppIndexedDbPrivateBootstrapStore } from "./packages/sdk/src/app-host/private-persistence-idb.ts";
import { AppCpPrivateBootstrap } from "./packages/sdk/src/app-host/private-bootstrap.ts";
const check=(v)=>{if(!v)throw Error("fixture assertion failed");};
const pin=(installationId="88888888-8888-8888-8888-888888888888")=>({connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId,isCurrent:()=>true});
const ns=p=>\`mdbase.app-noise.v1:\${p.connectorId}:\${p.deviceId}:\${p.installationId}\`;
async function hostFixtureKey(mode){
  // Fixture HOST key provider, not a production key-custody implementation.
  const db=await new Promise((yes,no)=>{const r=indexedDB.open("public-fixture-kek",1);r.onupgradeneeded=()=>{if(mode!=="fresh"){r.transaction.abort();return;}r.result.createObjectStore("key");};r.onsuccess=()=>yes(r.result);r.onerror=()=>no(Error("missing fixture host key"));});
  try {
    const key=await new Promise((yes,no)=>{const tx=db.transaction("key","readonly"),r=tx.objectStore("key").get("kek");tx.oncomplete=()=>yes(r.result);tx.onabort=()=>no(Error("key read failed"));});
    if(key){check(mode==="existing"&&!key.extractable);return key;}
    check(mode==="fresh");const made=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
    await new Promise((yes,no)=>{const tx=db.transaction("key","readwrite"),s=tx.objectStore("key"),r=s.get("kek");r.onsuccess=()=>{if(r.result!==undefined)tx.abort();else s.put(made,"kek");};tx.oncomplete=yes;tx.onabort=()=>no(Error("uncertain fixture key write"));});return made;
  }finally{db.close();}
}
self.onmessage=async e=>{let store,outcomeStore,rt;try{
  const signal=AbortSignal.timeout(15000),p=pin(),options={source:p,origin:location.origin,allowLoopbackHttp:true,mode:e.data.mode,signal};
  if(e.data.case==="atomic"){
    const q=pin("99999999-9999-9999-9999-999999999999"),opts={...options,source:q,mode:"fresh"};const a=await AppIndexedDbNoiseProtectedStore.open(opts),b=await AppIndexedDbNoiseProtectedStore.open(opts);
    try{const x=Uint8Array.of(7),y=Uint8Array.of(8),results=await Promise.all([a.compareAndSet(ns(q),null,x,{signal}),b.compareAndSet(ns(q),null,y,{signal})]);check(results.filter(Boolean).length===1);check(x[0]===7&&y[0]===8);const kept=await a.read(ns(q),{signal});check(kept.length===1&&kept[0]===(results[0]?7:8));
      check(await a.compareAndSet(ns(q),Uint8Array.of(99),Uint8Array.of(10),{signal})===false);let foreign=false;try{await a.read("foreign",{signal});}catch{foreign=true;}check(foreign);const stopped=new AbortController();stopped.abort();let aborted=false,budget=false,stale=false;try{await a.compareAndSet(ns(q),kept,Uint8Array.of(10),{signal:stopped.signal});}catch{aborted=true;}try{await a.compareAndSet(ns(q),kept,new Uint8Array(4097),{signal});}catch{budget=true;}check(aborted&&budget);check((await a.read(ns(q),{signal}))[0]===kept[0]);q.isCurrent=()=>false;try{await a.read(ns(q),{signal});}catch{stale=true;}check(stale);self.postMessage({atomicCas:true,foreignNamespaceRefused:true,abortBudgetScopeRefused:true});
    }finally{a.close();b.close();}return;
  }
  if(e.data.case==="refusals"){
    let fresh=false,missing=false,origin=false;try{await AppIndexedDbNoiseProtectedStore.open({...options,mode:"fresh"});}catch{fresh=true;}try{await AppIndexedDbNoiseProtectedStore.open({...options,source:pin("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),mode:"existing"});}catch{missing=true;}try{await AppIndexedDbNoiseProtectedStore.open({...options,origin:"https://foreign.invalid"});}catch{origin=true;}
    check(fresh&&missing&&origin);self.postMessage({existingFreshRefused:true,missingExistingRefused:true,foreignOriginRefused:true});return;
  }
  store=await AppIndexedDbNoiseProtectedStore.open(options);const key=await hostFixtureKey(e.data.mode);
  if(e.data.case==="corruption"){
    const before=await store.read(ns(p),{signal}),damaged=new Uint8Array(before);damaged[damaged.length-1]^=1;check(await store.compareAndSet(ns(p),before,damaged,{signal}));const vault=new AppWebNoiseCustody(p,key,store);let refused=false;try{await vault.restore({signal});}catch{refused=true;}check(refused);const after=await store.read(ns(p),{signal});check(after.length===damaged.length&&after.every((v,i)=>v===damaged[i]));self.postMessage({corruptCipherRefused:true,uncertainCipherPreserved:true});return;
  }
let exported=false;try{await crypto.subtle.exportKey("raw",key);exported=true;}catch{}check(!exported);
  const vault=new AppWebNoiseCustody(p,key,store),restored=e.data.mode==="existing"?await vault.restore({signal}):null;
  if(e.data.mode==="existing")check(restored&&(e.data.privateEnrol!==undefined||restored.receipt===null));
  const image=await(await fetch("/app.wasm")).arrayBuffer();rt=await AppWasmRuntime.createDevice(image);
  const sign=new Uint8Array(32).fill(1),kem=new Uint8Array(32).fill(2);
  const native=rt.openDeviceConsuming({pin:p,signSecretKey:sign,kemSecretKey:kem,opened:restored?{mode:"existing",envelope:restored.envelope}:{mode:"fresh"}});
  check(sign.every(v=>v===0)&&kem.every(v=>v===0));await vault.pending(native.envelope,{signal});
  if(e.data.privateEnrol!==undefined){
    // Public fixture HOST registration receipt, never a real CP registration claim.
    const collection="22222222-2222-2222-2222-222222222222",target={...p,collection,purpose:"enrol",approvalMode:"password-ak1"};
    if(e.data.privateEnrol==="fresh") {const receipt={...p,...native};await vault.registered(receipt,{signal});rt.acknowledgeDeviceRegistration(receipt);rt.preparePrivateCollection(target,{mode:"fresh"});await vault.privateEnrolPending(rt.privateEnrolMarker(),{signal});}
    else {check(restored&&restored.receipt&&restored.privateEnrolMarker);rt.acknowledgeDeviceRegistration(restored.receipt);rt.preparePrivateCollection(target,{mode:"existing",marker:restored.privateEnrolMarker});}
    if(e.data.privateOutcome){
      const session={...target,accountId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",cpOrigin:"https://cp.example",logOrigin:"https://log.example",rootPublicKey:new Uint8Array(32).fill(9),connectorBearer:async()=>{throw Error("known outcome must not request bearer");}};
      const marker=rt.privateEnrolMarker(),receipt=rt.registeredDeviceReceipt();
      outcomeStore=await AppIndexedDbPrivateBootstrapStore.open({source:session,origin:location.origin,allowLoopbackHttp:true,mode:e.data.privateOutcome==="commit"?"fresh":"existing",signal});
      let dropCompletion=false,dropAck=e.data.privateOutcome==="ack";
      const outcomeIO={read:o=>outcomeStore.read(o),compareAndSet:async(expected,value,o)=>{const saved=await outcomeStore.compareAndSet(expected,value,o);if(dropCompletion)throw Error("committed completion response lost");return saved;}};
      const noiseIO={privateEnrolPending:(m,o)=>vault.privateEnrolPending(m,o),privateEnrolAcknowledged:async(m,o)=>{await vault.privateEnrolAcknowledged(m,o);if(dropAck)throw Error("committed ACK response lost");}};
      const persistence=new AppWebPrivateBootstrapPersistence(session,receipt,key,outcomeIO,noiseIO);
      if(e.data.privateOutcome==="commit"){
        await persistence.privateEnrolPending(marker,{signal});
        const domain=new TextEncoder().encode("mdbase/v1/chain"),item=Uint8Array.of(1),input=new Uint8Array(domain.length+2);input[0]=domain.length;input.set(domain,1);input.set(item,domain.length+1);
        const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",input)),expectedGenesis="sha256:"+Array.from(hash,v=>v.toString(16).padStart(2,"0")).join("");
        dropCompletion=true;let unknown=false;try{await persistence.completed({collection,deviceId:p.deviceId,logOrigin:session.logOrigin,rootPublicKey:session.rootPublicKey,genesisItem:item,expectedGenesis,approval:"pending"},{signal});}catch{unknown=true;}check(unknown);
        const kept=await vault.restore({signal});check(kept&&!kept.privateEnrolMarker.acknowledged);
        self.postMessage({completionUnknownPreserved:true,ackNotInferred:true,noisePublic:[...native.noisePublicKey],publicCommit:[...marker.sasCommitment]});return;
      }
      const bootstrap=new AppCpPrivateBootstrap(rt,session,persistence,{fetch:async()=>{throw Error("known outcome must not POST");}});
      let ackUnknown=false,metadata;try{metadata=await bootstrap.bootstrap({signal});}catch{ackUnknown=true;}
      const kept=await vault.restore({signal});check(kept&&kept.privateEnrolMarker.acknowledged);
      if(dropAck){check(ackUnknown);self.postMessage({ackUnknownPreserved:true,noisePublic:[...native.noisePublicKey],publicCommit:[...marker.sasCommitment]});return;}
      check(!ackUnknown&&metadata&&metadata.approval==="pending"&&metadata.genesisItem[0]===1&&marker.acknowledged);
      let repeatRefused=false;try{rt.signPrivateDeviceEnrol(new Uint8Array(32).fill(19));}catch{repeatRefused=true;}check(repeatRefused);
      self.postMessage({knownCompletionNoPost:true,nativeAckReproofRefused:true,noisePublic:[...native.noisePublicKey],publicCommit:[...marker.sasCommitment]});return;
    }
    const nonce=new Uint8Array(32).fill(e.data.privateEnrol==="fresh"?17:18),proof=rt.signPrivateDeviceEnrol(nonce);check(proof.signature.length===64&&nonce.every(v=>v===(e.data.privateEnrol==="fresh"?17:18)));
    const kept=await vault.restore({signal});check(kept&&kept.privateEnrolMarker&&kept.privateEnrolMarker.sasCommitment.every((v,i)=>v===proof.sasCommitment[i]));
    self.postMessage({noisePublic:[...native.noisePublicKey],publicCommit:[...proof.sasCommitment],privateMarkerPersisted:true,nativeFreshNonceProof:true});return;
  }
  const saved=await vault.restore({signal});check(saved&&saved.receipt===null&&saved.envelope.every((v,i)=>v===native.envelope[i]));
  const encrypted=await store.read(ns(p),{signal});check(encrypted&&encrypted.length>native.envelope.length);
  self.postMessage({noisePublic:[...native.noisePublicKey],opaqueOuterPersisted:true,nonextractableKek:true,protectedLoansWiped:true,noRegistrationReceipt:true});
}catch{self.postMessage({error:"isolated persistent Noise fixture failed"});}finally{rt?.retireLog();outcomeStore?.close();store?.close();}};
`;
const bundle=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:"noise-idb-fixture.ts"},bundle:true,format:"esm",platform:"browser",write:false});
const wasm=await readFile(resolve(artifact)),worker=bundle.outputFiles[0].contents;
const server=createServer((req,res)=>{if(req.url==="/app.wasm"){res.setHeader("Content-Type","application/wasm");res.end(wasm);}else if(req.url==="/worker.js"){res.setHeader("Content-Type","text/javascript");res.end(worker);}else{res.setHeader("Content-Type","text/html");res.end("<!doctype html><title>isolated persistent Noise fixture</title>");}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${server.address().port}`;
async function run(context,data){const page=await context.newPage();await page.goto(origin);try{return await page.evaluate(data=>new Promise((yes,no)=>{const w=new Worker("/worker.js",{type:"module"}),timer=setTimeout(()=>{w.terminate();no(Error("persistent fixture timeout"));},20000);w.onmessage=e=>{clearTimeout(timer);w.terminate();e.data.error?no(Error(e.data.error)):yes(e.data);};w.onerror=()=>{clearTimeout(timer);w.terminate();no(Error("persistent fixture Worker failed"));};w.postMessage(data);}),data);}finally{await page.close();}}
let context;try{
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const first=await run(context,{mode:"fresh"});await context.close();context=null;
  // Actual browser process shutdown/restart, same OWNED profile/origin. No
  // physical crash/power-loss claim, no existing user's browser profile used.
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const warm=await run(context,{mode:"existing"});assert.deepEqual(warm.noisePublic,first.noisePublic);
  const pending=await run(context,{mode:"existing",privateEnrol:"fresh"});await context.close();context=null;
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const resumed=await run(context,{mode:"existing",privateEnrol:"existing"});assert.deepEqual(resumed.noisePublic,pending.noisePublic);assert.deepEqual(resumed.publicCommit,pending.publicCommit);assert(resumed.nativeFreshNonceProof&&pending.privateMarkerPersisted);
  const completionLost=await run(context,{mode:"existing",privateEnrol:"existing",privateOutcome:"commit"});assert(completionLost.completionUnknownPreserved&&completionLost.ackNotInferred);await context.close();context=null;
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const ackLost=await run(context,{mode:"existing",privateEnrol:"existing",privateOutcome:"ack"});assert(ackLost.ackUnknownPreserved);assert.deepEqual(ackLost.noisePublic,pending.noisePublic);assert.deepEqual(ackLost.publicCommit,pending.publicCommit);await context.close();context=null;
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const known=await run(context,{mode:"existing",privateEnrol:"existing",privateOutcome:"known"});assert(known.knownCompletionNoPost&&known.nativeAckReproofRefused);assert.deepEqual(known.noisePublic,pending.noisePublic);assert.deepEqual(known.publicCommit,pending.publicCommit);
  const negative=await run(context,{mode:"existing",case:"refusals"}),atomic=await run(context,{mode:"fresh",case:"atomic"}),corrupt=await run(context,{mode:"existing",case:"corruption"});
  console.log(JSON.stringify({actualSdk:true,actualAppWasm:true,actualChromiumIndexedDb:true,browserRestartReopen:true,noiseIdentityPreserved:true,nonextractableKekPersisted:true,privateEnrolMarkerRestartReopen:true,sameCommitNativeProofAfterRestart:true,publicCompletionAndNoiseAckRestart:true,knownCompletionNoNewPost:true,nativeAcknowledgedReproofRefused:true,...negative,...atomic,...corrupt,registrationQualified:false,hostSignKemCustodyQualified:false,mobileSecureStorageQualified:false,providerActivationQualified:false,physicalDurabilityQualified:false}));
}finally{await context?.close();await new Promise(r=>server.close(r));}
