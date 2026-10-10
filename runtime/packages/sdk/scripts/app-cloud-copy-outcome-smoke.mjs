#!/usr/bin/env node
/** Owned persistent Chromium/Worker/two Locks + actual browser KEK and exact
 * PUBLIC cloud outcome IDB. Identity/release/genesis are TEST fixtures. No CP,
 * native adoption, production auth/release/task/Saved/LAB/physical claim. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
if (!process.env.PLAYWRIGHT_MODULE)
    throw Error("explicit Playwright module required");
const playwright = await import(
        pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    ),
    out = resolve("target/cloud-copy-outcome-smoke"),
    profile = resolve(out, `profile-${process.pid}`);
await mkdir(out, { recursive: true });
const scope = {
    account: "11111111-1111-1111-1111-111111111111",
    installation: "88888888-8888-8888-8888-888888888888",
    collection: "22222222-2222-2222-2222-222222222222",
};
const workerSource = `
import {AppIndexedDbDeviceKeyProvider} from "./packages/sdk/src/app-host/device-key-provider.ts";
import {AppIndexedDbCloudCopyOutcomeStore} from "./packages/sdk/src/app-host/cloud-copy-persistence-idb.ts";
import {AppWebCloudCopyBootstrapPersistence} from "./packages/sdk/src/app-host/cloud-copy-persistence.ts";
let current=false,ctrl,provider,store,vault,initialized=false;
const check=v=>{if(!v)throw Error("owned outcome fixture assertion failed");};
self.onmessage=async({data})=>{try{
 if(data.op==="stop"){current=false;ctrl?.abort();vault?.close();store?.close();provider?.close();self.postMessage({id:data.id,stopped:true});return;}
 check(data.op==="init"&&!initialized&&data.owned===true);initialized=true;current=true;ctrl=new AbortController();const signal=ctrl.signal;
 const p={accountId:data.scope.account,installationId:data.scope.installation,connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",collection:data.scope.collection,purpose:"create",assetSha256:"aa".repeat(32),cpOrigin:"https://cp.example.test",logOrigin:"https://log.example.test",isCurrent:()=>current,installationOwned:()=>current};
 provider=await AppIndexedDbDeviceKeyProvider.open({source:p,origin:location.origin,mode:data.providerMode??data.mode,signal,allowLoopbackHttp:true});const key=provider.deviceCustodyKek({signal});check(!key.extractable);
 const opts={source:p,origin:location.origin,mode:data.mode,signal,allowLoopbackHttp:true};
 if(data.case==="missing"){let refused=false;try{store=await AppIndexedDbCloudCopyOutcomeStore.open(opts);}catch{refused=true;}check(refused);self.postMessage({id:data.id,missingExistingRefused:true});return;}
 const receipt={connectorId:p.connectorId,deviceId:p.deviceId,installationId:p.installationId,signPublicKey:new Uint8Array(32).fill(1),kemPublicKey:new Uint8Array(32).fill(2),noisePublicKey:new Uint8Array(32).fill(3)};
 store=await AppIndexedDbCloudCopyOutcomeStore.open(opts);
 // Fault injection ONLY after the actual strict-requested IDB commit. No retry.
 if(data.case==="lost"){const cas=store.compareAndSet;store.compareAndSet=async function(...args){const applied=await cas.apply(this,args);check(applied);throw Error("owned lost applied reply fixture");};}
 vault=new AppWebCloudCopyBootstrapPersistence(p,receipt,key,store,{mode:data.mode,signal});
 const operation={...receipt,accountId:p.accountId,collection:p.collection,purpose:p.purpose,assetSha256:p.assetSha256,cpOrigin:p.cpOrigin,logOrigin:p.logOrigin};
 const item=Uint8Array.of(1,2,3),d=new TextEncoder().encode("mdbase/v1/chain"),input=new Uint8Array(1+d.length+item.length);input[0]=d.length;input.set(d,1);input.set(item,1+d.length);const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",input)),metadata={operation,genesisItem:item,expectedGenesis:"sha256:"+Array.from(hash,v=>v.toString(16).padStart(2,"0")).join("")};
 const before=await vault.restore({signal});
 if(data.case==="lost"){check(before.state==="none");let unknown=false;try{await vault.pending(operation,{signal});}catch{unknown=true;}check(unknown);self.postMessage({id:data.id,lostAppliedPreserved:true});return;}
 if(data.case==="pending"){check(before.state==="pending");self.postMessage({id:data.id,pendingAfterRestart:true});return;}
 if(data.mode==="fresh"){check(before.state==="none");await vault.pending(operation,{signal});await vault.completed(metadata,{signal});}else{check(before.state==="completed");}
 const restored=await vault.restore({signal});check(restored.state==="completed"&&restored.metadata.expectedGenesis===metadata.expectedGenesis&&restored.metadata.genesisItem.join(",")===item.join(","));
 const cipher=await store.read({signal});check(cipher instanceof Uint8Array&&cipher.length>64);const original=new Uint8Array(cipher);cipher.fill(0);check((await store.read({signal})).every((v,i)=>v===original[i]));
 let fresh=false;try{await AppIndexedDbCloudCopyOutcomeStore.open({...opts,mode:"fresh"});}catch{fresh=true;}check(fresh);
 const foreign=new AppWebCloudCopyBootstrapPersistence({...p,assetSha256:"bb".repeat(32)},receipt,key,store,{mode:"existing",signal});let aad=false;try{await foreign.restore({signal});}catch{aad=true;}foreign.close();check(aad);check((await vault.restore({signal})).state==="completed");
 if(data.case==="version"){const name="mdbase.app.cloud-copy-outcome.v1."+[p.accountId,p.connectorId,p.deviceId,p.installationId,p.collection].map(v=>v.toLowerCase()).join(".")+".create";const db=await new Promise((yes,no)=>{const r=indexedDB.open(name,2);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(Error("owned version fixture failed"));});db.close();check(store.fenced);let fenced=false;try{await vault.restore({signal});}catch{fenced=true;}check(fenced);self.postMessage({id:data.id,versionChangeFenced:true});return;}
 self.postMessage({id:data.id,completed:true,existingFreshRefused:fresh,foreignAadPreserved:aad,cipherOnly:true,expectedGenesis:metadata.expectedGenesis});
}catch(e){self.postMessage({id:data.id,error:String(e.message)});}};
`;
const mainSource = `
import {openOwnedAppWorker,appInstallationLockName,appReplicaLockName} from "./packages/sdk/src/app-host/owner.ts";
window.runOutcome=async(scope,data)=>{let raw,id=0,answer;const rpc=(op,extra={})=>new Promise((yes,no)=>{const rid=++id,timer=setTimeout(()=>no(Error("owned outcome timeout")),15000),on=({data})=>{if(data.id!==rid)return;clearTimeout(timer);raw.removeEventListener("message",on);data.error?no(Error(data.error)):yes(data);};raw.addEventListener("message",on);raw.postMessage({id:rid,op,...extra});});
 const owner=await openOwnedAppWorker({locks:navigator.locks,scope,create:()=>{raw=new Worker("/worker.js",{type:"module"});return{stop:()=>rpc("stop"),terminate:()=>raw.terminate()};},initialize:async(_w,_signal,s,authority)=>{const locks=await navigator.locks.query();if(!authority.isCurrent()||![appInstallationLockName(s),appReplicaLockName(s)].every(n=>locks.held.some(l=>l.name===n)))throw Error("outcome installation not owned");answer=await rpc("init",{...data,scope:s,owned:authority.isCurrent()});},closeTimeoutMs:1000});
 try{return answer;}finally{await owner.close();if((await navigator.locks.query()).held.length)throw Error("outcome locks retained");}
};
`;
async function bundle(source, name) {
    return (
        await build({
            stdin: {
                contents: source,
                resolveDir: process.cwd(),
                sourcefile: name,
            },
            bundle: true,
            platform: "browser",
            format: "esm",
            write: false,
        })
    ).outputFiles[0].contents;
}
const worker = await bundle(workerSource, "cloud-outcome-worker.ts"),
    main = await bundle(mainSource, "cloud-outcome-main.ts");
const server = createServer((req, res) => {
    if (req.url === "/worker.js" || req.url === "/main.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(req.url === "/worker.js" ? worker : main);
    } else {
        res.setHeader("content-type", "text/html");
        res.end(
            '<!doctype html><title>Owned cloud outcome fixture</title><script type="module" src="/main.js"></script>',
        );
    }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
async function run(context, data, selectedScope = scope) {
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.runOutcome === "function");
    try {
        return await page.evaluate(
            ({ scope, data }) => window.runOutcome(scope, data),
            { scope: selectedScope, data },
        );
    } finally {
        await page.close();
    }
}
let context;
try {
    context = await playwright.chromium.launchPersistentContext(profile, {
        headless: true,
    });
    const cold = await run(context, { mode: "fresh" }),
        lostScope = {
            ...scope,
            installation: "99999999-9999-9999-9999-999999999999",
        },
        lost = await run(context, { mode: "fresh", case: "lost" }, lostScope);
    await context.close();
    context = null;
    context = await playwright.chromium.launchPersistentContext(profile, {
        headless: true,
    });
    const warm = await run(context, { mode: "existing" }),
        pending = await run(
            context,
            { mode: "existing", case: "pending" },
            lostScope,
        );
    assert(
        cold.completed &&
            warm.completed &&
            lost.lostAppliedPreserved &&
            pending.pendingAfterRestart,
    );
    assert.equal(cold.expectedGenesis, warm.expectedGenesis);
    const missing = await run(
            context,
            { mode: "existing", providerMode: "existing", case: "missing" },
            { ...scope, collection: "33333333-3333-3333-3333-333333333333" },
        ),
        version = await run(
            context,
            { mode: "fresh", case: "version" },
            { ...scope, installation: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        ),
        preserved = await run(context, { mode: "existing" });
    assert(
        missing.missingExistingRefused &&
            version.versionChangeFenced &&
            preserved.completed,
    );
    console.log(
        JSON.stringify({
            browser: context.browser()?.version(),
            actualWorker: true,
            actualTwoWebLocks: true,
            actualPersistentNonextractableKek: true,
            actualOutcomeIdbCiphertext: true,
            completionAcrossBrowserRestart: true,
            lostAppliedPendingAcrossBrowserRestart: true,
            missingExistingRefused: true,
            existingFreshRefused: true,
            foreignReleaseAadPreserved: true,
            distinctVersionChangeFenced: true,
            zeroLocksAfterTerminate: true,
            identitySelectionIsTestFixture: true,
            productionHostQualified: false,
            cpAuthentication: false,
            nativeAdoption: false,
            taskSaved: false,
            physicalDurability: false,
            labAccess: false,
        }),
    );
} finally {
    await context?.close();
    await new Promise((r) => server.close(r));
}
