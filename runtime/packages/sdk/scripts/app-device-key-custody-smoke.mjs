#!/usr/bin/env node
/** Isolated Chromium/Worker/Web Locks/IDB + actual native original-device keys.
 * Explicit artifact, owned profile, concrete first-party IDB CryptoKey provider.
 * Identity/authentication scope is a TEST host fixture. No CP/LAB/login,
 * production custody, applied/keyed/task/Saved or physical durability claims. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const artifact=process.argv[2];if(!artifact || !process.env.PLAYWRIGHT_MODULE)throw Error("explicit app artifact and Playwright module required");
const playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href),out=resolve("target/device-key-custody-smoke"),profile=resolve(out,`profile-${process.pid}`);await mkdir(out,{recursive:true});
const scope={account:"11111111-1111-1111-1111-111111111111",installation:"88888888-8888-8888-8888-888888888888",collection:"22222222-2222-2222-2222-222222222222"};
const workerSource=`
import {AppWasmRuntime,AppWebDeviceKeyCustody,AppIndexedDbDeviceKeyProtectedStore,AppIndexedDbDeviceKeyProvider,AppWebNoiseCustody,AppIndexedDbNoiseProtectedStore} from "./packages/sdk/src/app-host/index.ts";
const check=v=>{if(!v)throw Error("owned custody fixture assertion failed");};
let rt,keys,noise,provider,ctrl,originalScope,current=false,initialized=false;
const source=scope=>({accountId:scope.account,connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:scope.installation,isCurrent:()=>current,installationOwned:()=>current&&scope.account===originalScope.account&&scope.installation===originalScope.installation});
const ns=p=>"mdbase.app-device-keys.v1:"+[p.accountId,p.connectorId,p.deviceId,p.installationId].map(v=>v.toLowerCase().replaceAll("-","")).join(":");
self.onmessage=async({data})=>{try{
  if(data.op==="stop"){current=false;ctrl?.abort();await rt?.close();keys?.close();noise?.close();provider?.close();self.postMessage({id:data.id,stopped:true});return;}
  check(data.op==="init"&&!initialized&&data.owned===true);initialized=true;current=true;originalScope=data.scope;ctrl=new AbortController();const signal=ctrl.signal,p=source(data.scope),opts={source:p,origin:location.origin,allowLoopbackHttp:true,mode:data.mode,signal};
  if(data.case==="atomic"){
    const q=source(data.scope),o={...opts,source:q,mode:"fresh"},a=await AppIndexedDbDeviceKeyProtectedStore.open(o),b=await AppIndexedDbDeviceKeyProtectedStore.open(o);
    try{const result=await Promise.all([a.create(ns(q),Uint8Array.of(7),{signal}),b.create(ns(q),Uint8Array.of(8),{signal})]);check(result.filter(Boolean).length===1);const kept=await a.read(ns(q),{signal});check(kept[0]===(result[0]?7:8));check(await a.create(ns(q),Uint8Array.of(9),{signal})===false);let foreign=false,budget=false,abort=false;try{await a.read("foreign",{signal});}catch{foreign=true;}try{await a.create(ns(q),new Uint8Array(257),{signal});}catch{budget=true;}const c=new AbortController();c.abort();try{await a.read(ns(q),{signal:c.signal});}catch{abort=true;}check(foreign&&budget&&abort);check((await a.read(ns(q),{signal}))[0]===kept[0]);self.postMessage({id:data.id,atomicCreate:true,foreignBudgetAbortPreserved:true});}finally{a.close();b.close();}return;
  }
  if(data.case==="refusals"){
    let existing=false,missing=false,foreign=false;try{await AppIndexedDbDeviceKeyProtectedStore.open({...opts,mode:"fresh"});}catch{existing=true;}try{await AppIndexedDbDeviceKeyProtectedStore.open({...opts,source:{...source(data.scope),deviceId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},mode:"existing"});}catch{missing=true;}try{await AppIndexedDbDeviceKeyProtectedStore.open({...opts,origin:"https://foreign.invalid"});}catch{foreign=true;}check(existing&&missing&&foreign);self.postMessage({id:data.id,existingFreshRefused:true,missingExistingRefused:true,foreignOriginRefused:true});return;
  }
  if(data.case==="provider-refusals"){
    let existing=false,missing=false,foreign=false,unowned=false,aborted=false;
    try{await AppIndexedDbDeviceKeyProvider.open({...opts,mode:"fresh"});}catch{existing=true;}
    try{await AppIndexedDbDeviceKeyProvider.open({...opts,source:{...p,deviceId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"},mode:"existing"});}catch{missing=true;}
    try{await AppIndexedDbDeviceKeyProvider.open({...opts,origin:"https://foreign.invalid"});}catch{foreign=true;}
    try{await AppIndexedDbDeviceKeyProvider.open({...opts,source:{...p,installationOwned:()=>false}});}catch{unowned=true;}
    const a=new AbortController();a.abort();try{await AppIndexedDbDeviceKeyProvider.open({...opts,signal:a.signal});}catch{aborted=true;}
    provider=await AppIndexedDbDeviceKeyProvider.open(opts);const key=provider.deviceCustodyKek({signal});let reused=false;try{provider.deviceCustodyKek({signal});}catch{reused=true;}check(existing&&missing&&foreign&&unowned&&aborted&&reused&&!key.extractable);self.postMessage({id:data.id,existingMissingForeignUnownedAbortPreserved:true,providerSingleLoan:true});return;
  }
  if(data.case==="provider-version"){
    provider=await AppIndexedDbDeviceKeyProvider.open(opts);
    const name="mdbase.app.device-key-kek.v1."+[p.accountId,p.connectorId,p.deviceId,p.installationId].map(v=>v.replaceAll("-","")).join(".");
    const db=await new Promise((yes,no)=>{const r=indexedDB.open(name,2);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(Error("owned version fixture failed"));});db.close();
    let fenced=false;try{provider.deviceCustodyKek({signal});}catch{fenced=true;}check(fenced);self.postMessage({id:data.id,versionChangeFenced:true});return;
  }
  keys=await AppIndexedDbDeviceKeyProtectedStore.open(opts);noise=await AppIndexedDbNoiseProtectedStore.open(opts);provider=await AppIndexedDbDeviceKeyProvider.open(opts);const key=provider.deviceCustodyKek({signal});let exported=false;try{await crypto.subtle.exportKey("raw",key);exported=true;}catch{}check(!exported);
  const vault=new AppWebDeviceKeyCustody(p,key,keys),noiseVault=new AppWebNoiseCustody(p,key,noise),restored=data.mode==="existing"?await noiseVault.restore({signal}):null;if(data.mode==="existing")check(restored);
  rt=await AppWasmRuntime.createDevice(await(await fetch("/app.wasm",{credentials:"omit",redirect:"error",signal})).arrayBuffer());
  const native=await vault.openNativeDevice(rt,{signal,mode:data.mode,noise:restored?{mode:"existing",envelope:restored.envelope}:{mode:"fresh"}});await noiseVault.pending(native.envelope,{signal});
  const cipher=await keys.read(ns(p),{signal});check(cipher&&cipher.length>80&&cipher.length<=256);
  let reused=false;try{await vault.openNativeDevice(rt,{signal,mode:data.mode,noise:{mode:"fresh"}});}catch{reused=true;}check(reused);
  self.postMessage({id:data.id,public:[...native.signPublicKey,...native.kemPublicKey,...native.noisePublicKey],actualNative:true,cipherOnly:true,nonextractableKek:true,singleUse:true});
}catch{self.postMessage({id:data.id,error:"owned device key custody fixture failed"});}};
`;
const mainSource=`
import {openOwnedAppWorker,appInstallationLockName,appReplicaLockName} from "./packages/sdk/src/app-host/index.ts";
window.runCustody=async(scope,data)=>{let raw,id=0,answer;const rpc=(op,extra={})=>new Promise((yes,no)=>{const rid=++id,timer=setTimeout(()=>no(Error("owned custody fixture timeout")),15000),on=({data})=>{if(data.id!==rid)return;clearTimeout(timer);raw.removeEventListener("message",on);data.error?no(Error(data.error)):yes(data);};raw.addEventListener("message",on);raw.postMessage({id:rid,op,...extra});});
  const owner=await openOwnedAppWorker({locks:navigator.locks,scope,create:()=>{raw=new Worker("/worker.js",{type:"module"});return{stop:()=>rpc("stop"),terminate:()=>raw.terminate()};},initialize:async(_w,_signal,s,authority)=>{const locks=await navigator.locks.query();if(!authority.isCurrent()||![appInstallationLockName(s),appReplicaLockName(s)].every(n=>locks.held.some(l=>l.name===n)))throw Error("installation custody not owned");answer=await rpc("init",{...data,scope:s,owned:authority.isCurrent()});},closeTimeoutMs:1000});
  try{return answer;}finally{await owner.close();const locks=await navigator.locks.query();if(locks.held.length)throw Error("owned custody locks retained unexpectedly");}
};
`;
async function bundle(source,name){return(await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:name},bundle:true,platform:"browser",format:"esm",write:false})).outputFiles[0].contents;}
const worker=await bundle(workerSource,"device-key-worker.ts"),main=await bundle(mainSource,"device-key-main.ts"),wasm=await readFile(resolve(artifact));
const server=createServer((req,res)=>{if(req.url==="/app.wasm"){res.setHeader("content-type","application/wasm");res.end(wasm);}else if(req.url==="/worker.js"||req.url==="/main.js"){res.setHeader("content-type","text/javascript");res.end(req.url==="/worker.js"?worker:main);}else{res.setHeader("content-type","text/html");res.end('<!doctype html><title>Owned device key custody fixture</title><script type="module" src="/main.js"></script>');}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));const origin=`http://127.0.0.1:${server.address().port}`;
async function run(context,data,selectedScope=scope){const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>typeof window.runCustody==="function");try{return await page.evaluate(({scope,data})=>window.runCustody(scope,data),{scope:selectedScope,data});}finally{await page.close();}}
let context;try{
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const first=await run(context,{mode:"fresh"});await context.close();context=null;
  context=await playwright.chromium.launchPersistentContext(profile,{headless:true});const warm=await run(context,{mode:"existing"});assert.deepEqual(warm.public,first.public);assert(first.actualNative&&warm.cipherOnly&&warm.singleUse);
  const atomic=await run(context,{mode:"fresh",case:"atomic"},{...scope,installation:"99999999-9999-9999-9999-999999999999"}),refusals=await run(context,{mode:"existing",case:"refusals"}),providerRefusals=await run(context,{mode:"existing",case:"provider-refusals"}),versionChange=await run(context,{mode:"fresh",case:"provider-version"},{...scope,installation:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"});
  const preserved=await run(context,{mode:"existing"});assert.deepEqual(preserved.public,first.public);
  console.log(JSON.stringify({browser:context.browser()?.version(),actualNativeWorker:true,actualWebLocks:true,actualIdbCiphertext:true,sameOriginalSignKemNoiseAfterBrowserRestart:true,actualWebDeviceKeyProvider:true,nonextractablePersistentKek:true,singleUse:true,atomic,refusals,providerRefusals,versionChange,authenticatedHostProducerQualified:false,productionKeyProviderQualified:false,physicalDurabilityQualified:false,cpAuthentication:false,labAccess:false}));
}finally{await context?.close();await new Promise(r=>server.close(r));}
