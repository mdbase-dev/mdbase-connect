/** LOCAL TEST: actual SDK static-key custody in an isolated unpacked MV3
 * extension. Requires PLAYWRIGHT_MODULE; optional CHROMIUM_EXECUTABLE.
 * Never uses a user's browser/profile. Prints public identity/booleans only. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {resolve, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";
const sdk = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidence = resolve(sdk, "../../target/key-custody");
if (!process.env.PLAYWRIGHT_MODULE) throw Error("PLAYWRIGHT_MODULE is required");
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE);
await mkdir(evidence, {recursive:true});
const work = await mkdtemp(join(evidence,"mv3-"));
const extension = join(work,"extension"), profile = join(work,"profile");
const shared = `
import {indexedDbKeyStorage,loadOrCreateClientKey} from "./src/keys.ts";
import {x25519} from "@noble/curves/ed25519.js";
const DB="owned-sdk-custody-smoke", contextIncarnation=crypto.randomUUID();
const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const check=(ok,message)=>{if(!ok) throw Error(message);};
async function probe(scope) {
  // Each call uses a DISTINCT storage wrapper/connection. The page and worker
  // execute this simultaneously: WeakMap coalescing alone cannot pass it.
  const keys=await Promise.all(Array.from({length:16},()=>loadOrCreateClientKey("identity",{storage:indexedDbKeyStorage(DB),requireNonExtractable:true})));
  check(keys.every(k=>k.nonExtractable&&eq(k.publicKey,keys[0].publicKey)),"competing identities returned");
  const storage=indexedDbKeyStorage(DB);
  const original=await storage.get("identity");
  check(original?.kind==="webcrypto"&&original.privateKey.extractable===false,"wrong stored custody");
  let exportRefused=false;
  try {await crypto.subtle.exportKey("pkcs8",original.privateKey);} catch(error) {exportRefused=error.name==="InvalidAccessError";}
  check(exportRefused,"private export accepted");
  const peer=await loadOrCreateClientKey("peer",{storage,requireNonExtractable:true});
  const a=await keys[0].dh(peer.publicKey), b=await peer.dh(keys[0].publicKey);
  const sharedSecretMatches=eq(a,b)&&a.length===32;a.fill(0);b.fill(0);
  check(sharedSecretMatches,"static DH mismatch");
  // Owned legacy fixtures are separate from the consent identity and never
  // silently replaced by SDK calls, including on restart/reopen.
  const rawName="legacy-raw-"+scope, extractName="legacy-extractable-"+scope;
  if(await storage.get(rawName)===undefined) {
    const secretKey=x25519.utils.randomSecretKey();
    await storage.putIfAbsent(rawName,{kind:"raw",secretKey,publicKey:x25519.getPublicKey(secretKey)});
  }
  if(await storage.get(extractName)===undefined) {
    const pair=await crypto.subtle.generateKey({name:"X25519"},true,["deriveBits"]);
    await storage.putIfAbsent(extractName,{kind:"webcrypto",privateKey:pair.privateKey,publicKey:new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey))});
  }
  for(const name of [rawName,extractName]) {
    const before=await storage.get(name);let rejected=false;
    try {await loadOrCreateClientKey(name,{storage,requireNonExtractable:true});}
    catch(error) {rejected=error.code==="invalid_request";}
    const after=await storage.get(name);
    check(rejected&&before.kind===after.kind&&eq(before.publicKey,after.publicKey),"legacy identity accepted/rotated");
    if(before.kind==="raw") check(eq(before.secretKey,after.secretKey),"legacy private material replaced");
    else check(after.privateKey.extractable===true,"extractable identity silently replaced");
  }
  // Real IDB fault, after request success but before commit. Instrument only a
  // dedicated owned DB; no factory/receipt/source stand-in.
  const abortDB=DB+"-abort-"+scope, abortStorage=indexedDbKeyStorage(abortDB);
  const originalPut=IDBObjectStore.prototype.put;
  let requestSucceeded=false, abortRejected=false;
  IDBObjectStore.prototype.put=function(...args) {
    const request=Reflect.apply(originalPut,this,args);
    if(this.transaction.db.name===abortDB) {
      const transaction=this.transaction;
      request.addEventListener("success",()=>{requestSucceeded=true;transaction.abort();});
    }
    return request;
  };
  try {await abortStorage.put("must-not-commit",original);}
  catch {abortRejected=true;}
  finally {IDBObjectStore.prototype.put=originalPut;}
  check(requestSucceeded&&abortRejected&&await abortStorage.get("must-not-commit")===undefined,"aborted write acknowledged");
  return {contextIncarnation,publicKey:Array.from(keys[0].publicKey),nonExtractable:true,exportRefused,sharedSecretMatches,atomicConnectionCreation:true,existingRawRefused:true,existingExtractableRefused:true,lateAbortRefused:true};
}
`;
let context;
const launch = () => chromium.launchPersistentContext(profile, {
  headless:true,
  ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {}),
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
});
const worker = async () => context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker",{timeout:20000});
try {
  await mkdir(extension);
  await writeFile(join(extension,"manifest.json"),JSON.stringify({manifest_version:3,name:"Owned SDK custody acceptance test",version:"0.0.1",background:{service_worker:"worker.js",type:"module"}}));
  await writeFile(join(extension,"page.html"),'<!doctype html><title>Owned SDK custody test</title><script type="module" src="page.js"></script>');
  const workerCode=shared+`
globalThis.probe=()=>probe("worker");
chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
  if(message!=="probe") return;
  globalThis.probe().then(reply,error=>reply({error:error.message}));return true;
});`;
  const pageCode=shared+'\nglobalThis.probe=()=>probe("page");';
  for(const [file,contents] of [["worker.js",workerCode],["page.js",pageCode]]) {
    await build({stdin:{contents,resolveDir:sdk,sourcefile:file},bundle:true,format:"esm",platform:"browser",target:"chrome125",outfile:join(extension,file)});
  }
  context=await launch();
  const sw=await worker(), page=await context.newPage();
  await page.goto(`chrome-extension://${sw.url().split("/")[2]}/page.html`);
  await page.waitForFunction(()=>typeof globalThis.probe==="function");
  const [first,pageFirst]=await Promise.all([sw.evaluate(()=>globalThis.probe()),page.evaluate(()=>globalThis.probe())]);
  assert.deepEqual(first.publicKey,pageFirst.publicKey);
  const cdp=await context.newCDPSession(page);await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const restarted=await page.evaluate(()=>chrome.runtime.sendMessage("probe"));
  // A stop request/Playwright handle is not lifetime evidence: require a fresh
  // actual module execution, while the committed consent identity stays fixed.
  assert.equal(restarted.error,undefined);
  assert.notEqual(restarted.contextIncarnation,first.contextIncarnation,"worker JS execution was not restarted");
  assert.deepEqual(restarted.publicKey,first.publicKey);
  const version=context.browser().version();
  await context.close();context=undefined;
  context=await launch();
  const reopened=await (await worker()).evaluate(()=>globalThis.probe());
  assert.notEqual(reopened.contextIncarnation,restarted.contextIncarnation);
  assert.deepEqual(reopened.publicKey,first.publicKey);
  const keysSourceSha256=createHash("sha256").update(await readFile(join(sdk,"src/keys.ts"))).digest("hex");
  console.log(JSON.stringify({browser:version,keysSourceSha256,actualSdk:true,crossPageWorkerCreation:true,workerStopWake:true,browserReopen:true,stablePublicIdentity:true,first,pageFirst,restarted,reopened,physicalDurabilityQualified:false,hardwareBacked:false}));
} finally {
  await context?.close();await rm(work,{recursive:true,force:true});
}
