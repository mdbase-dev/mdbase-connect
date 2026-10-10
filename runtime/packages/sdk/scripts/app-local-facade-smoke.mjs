#!/usr/bin/env node
/** Isolated localhost Chromium: real dedicated WASM + official OPFS SQLite in
 * ONE owned Worker, ordinary SDK client frames over the local facade.
 * CP-signed metadata/registration receipt are PUBLIC TEST FIXTURES. No CP login,
 * applied-policy/keyed/task/Saved/LAB or physical-durability acceptance claimed.
 * Explicit artifact, owned Connect source and owned owner.ts required.
 * Optional fourth argument: owned TaskNotes intake checkout, using its installed
 * exact SDK/storage archives and actual Worker-only integrity loader.
 */
import assert from "node:assert/strict";
import { appPolicyPinsFixture } from "./app-policy-pins-fixture.mjs";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID, randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { build } from "../node_modules/esbuild/lib/main.js";
const [artifact, cpCheckout, ownerSource, tasknotesIntake] = process.argv.slice(2);
if (!artifact || !cpCheckout || !ownerSource || !process.env.PLAYWRIGHT_MODULE) throw Error("explicit artifact/owned CP/owner source/Playwright required");
const out = new URL("../../../target/local-facade-smoke/", import.meta.url); mkdirSync(out, { recursive: true });
const cp = name => JSON.stringify(resolve(cpCheckout, `services/server/src/features/next/${name}.ts`));
await build({ stdin: { contents: `export {certDigest,keyId,chainHash,signPolicyItem,encodeCbor} from ${cp("policy-wire")};export {ed25519RawPublicKey} from ${cp("policy-keys")};`, resolveDir: resolve(cpCheckout, "services/server") }, bundle: true, platform: "node", format: "esm", outfile: new URL("cp.mjs", out).pathname });
const policyWire = await import(new URL("cp.mjs", out));
const helperSource = tasknotesIntake
  ? `export * from ${JSON.stringify(resolve(tasknotesIntake, 'node_modules/@mdbase-dev/sdk/dist/index.js'))};export * from ${JSON.stringify(resolve(tasknotesIntake, 'node_modules/@mdbase-dev/sdk/dist/app-host/index.js'))};export {AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from ${JSON.stringify(resolve(tasknotesIntake, 'node_modules/@mdbase-dev/obsidian-runtime/dist/index/appSqliteIndex.js'))};export {loadLocalRuntimeArtifact} from ${JSON.stringify(resolve(tasknotesIntake, 'src/storage/local-runtime-artifact.ts'))};`
  : `export * from './src/index.ts';export * from './src/app-host/wasm-runtime.ts';export * from './src/app-host/local-facade.ts';export {AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex} from '../obsidian-runtime/src/index/appSqliteIndex.ts';export * from ${JSON.stringify(resolve(ownerSource))};`;
await build({ stdin: { contents: helperSource, resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, platform: "browser", format: "esm", outfile: new URL("helpers.js", out).pathname });
const scope = { account: randomUUID(), installation: randomUUID(), collection: randomUUID() };
const fixture = { scope, connectorId: randomUUID(), deviceId: randomUUID(), replicaId: randomUUID(), signSeed: [...randomBytes(32)], kemSeed: [...randomBytes(32)] };
const root = generateKeyPairSync("ed25519").privateKey, policy = generateKeyPairSync("ed25519").privateKey;
const rootPublicKey = policyWire.ed25519RawPublicKey(root), now = Date.now();
const cert = { policyPublicKey: policyWire.ed25519RawPublicKey(policy), notBefore: now - 60000, notAfter: now + 30 * 86400000, root: policyWire.keyId(rootPublicKey) };
cert.signature = sign(null, policyWire.certDigest(cert), root);
// Known PUBLIC fixture context, supplied before any simulated CP response.
// Not a release trust-asset parser/verifier or runtime authority discovery.
fixture.rootPublicKey = [...rootPublicKey];
fixture.policyPins = [...appPolicyPinsFixture(rootPublicKey, cert.policyPublicKey, policyWire.encodeCbor)];
let originalTuple, metadata;
const worker = `
import init from '/sqlite/index.mjs';
import {AppWasmRuntime,AppBinaryIndexHost,appSqlHost,openAppSahpoolIndex,attachAppLocalFacade${tasknotesIntake ? ',loadLocalRuntimeArtifact' : ''}} from '/helpers.js';
let rt,state,attachment,fixture,current=true,stallFrames=false,sqlCalls=0,stage='idle';
const publicArray=bytes=>Array.from(bytes);
const rpc=async m=>{
 if(m.op==='open') {
  stage='fixture';fixture=await (await fetch('/fixture.json')).json();
  const source={connectorId:fixture.connectorId,deviceId:fixture.deviceId,installationId:fixture.scope.installation,isCurrent:()=>current};
  stage='module';rt=await AppWasmRuntime.createDevice(${tasknotesIntake ? 'await loadLocalRuntimeArtifact(AbortSignal.timeout(10000))' : "await (await fetch('/app.wasm')).arrayBuffer()"});
  const signSecretKey=Uint8Array.from(fixture.signSeed),kemSecretKey=Uint8Array.from(fixture.kemSeed);
  fixture.signSeed.fill(0);fixture.kemSeed.fill(0);
  stage='device-open';const custody=rt.openDeviceConsuming({pin:source,signSecretKey,kemSecretKey,opened:m.envelope?{mode:'existing',envelope:Uint8Array.from(m.envelope)}:{mode:'fresh'}});
  if(signSecretKey.some(b=>b!==0)||kemSecretKey.some(b=>b!==0))throw Error('fixture native loans not consumed');
  // Retain the native fresh-registration proof-issued gate; no bypass for the
  // host receipt fixture. No live authenticated CP receiver is claimed here.
  if(!m.envelope)rt.signCpEnrol(crypto.getRandomValues(new Uint8Array(32)));
  stage='receipt-fixture';rt.acknowledgeDeviceRegistration({...source,...custody});
  stage='signed-metadata';const response=await fetch('/signed-metadata',{method:'POST',body:JSON.stringify({signPublicKey:publicArray(custody.signPublicKey),kemPublicKey:publicArray(custody.kemPublicKey),noisePublicKey:publicArray(custody.noisePublicKey)})});
  if(!response.ok)throw Error('fixture original tuple mismatch');
  const metadata=await response.json();
  stage='sqlite-init';const sqlite=await init({print:()=>{},printErr:()=>{}});
  stage='sqlite-open';state=await openAppSahpoolIndex(sqlite,fixture.scope);
  const opened=state.index.info.opened;
  const run=state.index.run.bind(state.index);state.index.run=(...args)=>{++sqlCalls;return run(...args);};
  const host=new AppBinaryIndexHost(state.index),sql={import:exports=>appSqlHost(host,exports),fence:()=>host.fence(),get needsRecovery(){return host.needsRecovery;}};
  const v=sqlite.version.libVersion.split('.').map(Number);
  stage='adopt';rt.adoptDevice({collection:fixture.scope.collection,replicaId:fixture.replicaId,deviceId:fixture.deviceId,endpoint:37,trustedRoots:[Uint8Array.from(fixture.rootPublicKey)],policyPins:Uint8Array.from(fixture.policyPins),trustedSigners:[],expectedGenesis:metadata.expectedGenesis,state:'cloud_copy',cloudCopyOptIn:true,opened:opened==='Fresh'?'fresh':opened==='Unclean'?'unclean':'existing',sqliteVersion:v[0]*1000000+v[1]*1000+v[2]},sql);
  return {opened,durability:state.index.info.durability,sqlCalls,envelope:publicArray(custody.envelope),observations:rt.observations()};
 }
 if(m.op==='attach') {
  // Fault layer drops ordinary frames only; it never alters Core authority.
  attachment=attachAppLocalFacade({connect:options=>{const port=rt.connect(options),send=port.send.bind(port);port.send=frame=>{if(!stallFrames)send(frame);};return port;}},m.port,{...fixture.scope,isCurrent:()=>current});return true;
 }
 if(m.op==='stall-frames') {stallFrames=true;return true;}
 if(m.op==='inspect') {
  const rows=state.index.run({mode:'Autocommit',stmts:[{sql:'SELECT k FROM st_meta',params:[]}]})[0].values;
  return {metadataRows:rows.length,keyringPersisted:rows.some(v=>typeof v.value==='string'&&/keyring/i.test(v.value)),sqlCalls};
 }
 if(m.op==='fence') {current=false;return true;}
 if(m.op==='close') {attachment?.close();await rt.close();state.index.close();await state.pool.pauseVfs();return true;}
 throw Error('invalid fixture operation');
};
onmessage=async({data:m})=>{try{postMessage({id:m.id,value:await rpc(m)});}catch{postMessage({id:m.id,error:true,stage});}};
`;
const sqlite = tasknotesIntake
  ? pathToFileURL(dirname(createRequire(realpathSync(resolve(tasknotesIntake, 'node_modules/@mdbase-dev/obsidian-runtime')) + '/package.json').resolve('@sqlite.org/sqlite-wasm/package.json')) + '/dist/')
  : new URL("../../obsidian-runtime/node_modules/@sqlite.org/sqlite-wasm/dist/", import.meta.url);
const assets = new Map([
  ["/helpers.js", ["text/javascript", readFileSync(new URL("helpers.js", out))]],
  ["/worker.js", ["text/javascript", worker]],
  ["/app.wasm", ["application/wasm", readFileSync(artifact)]],
]);
if (tasknotesIntake) {
  const pin = JSON.parse(readFileSync(resolve(tasknotesIntake, 'vendor/mdbase-app-local-b3e605ac.json'), 'utf8'));
  assets.set(`/vendor/${pin.wasm.file}`, ['application/wasm', readFileSync(resolve(tasknotesIntake, 'vendor', pin.wasm.file))]);
}
for (const name of ["index.mjs", "sqlite3.wasm", "sqlite3-opfs-async-proxy.js"]) assets.set(`/sqlite/${name}`, [name.endsWith(".wasm") ? "application/wasm" : "text/javascript", readFileSync(new URL(name, sqlite))]);
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/fixture.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(fixture)); return; }
    if (req.url === "/signed-metadata" && req.method === "POST") {
      let body = ""; for await (const bytes of req) { body += bytes; if (body.length > 4096) throw Error("fixture bounds"); }
      const tuple = JSON.parse(body);
      for (const key of ["signPublicKey", "kemPublicKey", "noisePublicKey"]) assert(Array.isArray(tuple[key]) && tuple[key].length === 32 && tuple[key].every(b => Number.isInteger(b) && b >= 0 && b <= 255));
      if (originalTuple) assert.deepEqual(tuple, originalTuple);
      else {
        originalTuple = tuple;
        const genesis = policyWire.signPolicyItem({privateKey:policy,cert}, {collection:scope.collection,seq:1,prev:new Uint8Array(32),issuedAt:now,previousIssuedAt:0,ops:[
          {op:"genesis",owner:scope.account,root:cert.root,state:"cloud-copy"},
          {op:"device-enrol",device:fixture.deviceId,account:scope.account,kind:"app-runtime",signPublicKey:Uint8Array.from(tuple.signPublicKey),kemPublicKey:Uint8Array.from(tuple.kemPublicKey),noisePublicKey:Uint8Array.from(tuple.noisePublicKey)},
        ]});
        metadata={rootPublicKey:[...rootPublicKey],expectedGenesis:`sha256:${Buffer.from(policyWire.chainHash(genesis)).toString("hex")}`};
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(metadata)); return;
    }
    const asset = assets.get(req.url); res.setHeader("content-type", asset?.[0] ?? "text/html"); res.end(asset?.[1] ?? "<!doctype html><title>isolated local Core OPFS facade</title>");
  } catch { res.statusCode = 400; res.end("fixture unavailable"); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
let browser;
try {
  browser = await playwright.chromium.launch({headless:true});
  const context=await browser.newContext(),page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async scope => {
    const {openOwnedAppWorker,appLocalConnector,connect}=await import('/helpers.js');
    let requestId=0,lastStage='worker-start';
    const create=()=>{
      const raw=new Worker('/worker.js',{type:'module'});
      const call=(op,fields={},transfer=[])=>new Promise((resolve,reject)=>{
        const id=++requestId,timer=setTimeout(()=>{connector?.close();raw.terminate();reject(Error('owned fixture Worker timeout'));},15000);
        const listener=({data})=>{if(data.id!==id)return;clearTimeout(timer);raw.removeEventListener('message',listener);if(data.error){lastStage=data.stage;reject(Error('owned fixture Worker failed'));}else resolve(data.value);};
        raw.addEventListener('message',listener);raw.postMessage({id,op,...fields},transfer);
      });
      raw.addEventListener('error',()=>connector?.close());
      return {call,stop:()=>call('close'),terminate:()=>{connector?.close();raw.terminate();}};
    };
    let opened,owned,client,connector;
    try {
      owned=await openOwnedAppWorker({locks:navigator.locks,scope,create,initialize:async w=>{opened=await w.call('open');}});
      const envelope=opened.envelope,initial=opened.opened;
      const makeClient=async()=>{const {port1,port2}=new MessageChannel();await owned.worker.call('attach',{port:port1},[port1]);connector=appLocalConnector(port2,{...owned.scope,isCurrent:()=>true});return connect({app:{name:'[test]-clients-local-facade',version:'0'},connector,reconnect:false,signal:AbortSignal.timeout(10000)});};
      client=await makeClient();
      if(client.collection!==scope.collection)throw Error('wrong native collection');
      const status=await client.getStatus(),inspection=await owned.worker.call('inspect');
      if(initial!=='Fresh'||inspection.metadataRows===0||inspection.keyringPersisted)throw Error('native SQL fixture mismatch');
      client.close();client=null;
      // Deliberately unclean: stop Native/SQL ONLY by terminating before unlock.
      owned.worker.stop=async()=>{};await owned.close();owned=null;
      let reopened;
      owned=await openOwnedAppWorker({locks:navigator.locks,scope,create,initialize:async w=>{reopened=await w.call('open',{envelope});}});
      if(reopened.opened!=='Unclean'||reopened.durability!=='Disposable')throw Error('unclean original-owner reopen mismatch');
      client=await makeClient();const warm=await owned.worker.call('inspect');
      if(warm.metadataRows!==inspection.metadataRows||warm.keyringPersisted)throw Error('native retained metadata mismatch');
      await owned.worker.call('fence');
      let sourceFenced=false;try{await client.getStatus();}catch{sourceFenced=true;}
      if(!sourceFenced)throw Error('stale Worker source served another frame');
      connector.close();client.close();client=null;await owned.close();owned=null;
      let clean;
      owned=await openOwnedAppWorker({locks:navigator.locks,scope,create,initialize:async w=>{clean=await w.call('open',{envelope});}});
      if(clean.opened!=='Existing')throw Error('clean same-owner reopen mismatch');
      await owned.close();owned=null;
      owned=await openOwnedAppWorker({locks:navigator.locks,scope,create,closeTimeoutMs:25,initialize:async w=>{await w.call('open',{envelope});}});
      client=await makeClient();await owned.worker.call('stall-frames');
      const pendingRejected=client.getStatus().then(()=>false,()=>true);
      owned.worker.stop=()=>new Promise(()=>{}); // actual Native/SQL Worker remains alive until fail-stop
      await owned.close();owned=null;
      const terminatedPendingRejected=await pendingRejected;
      if(!terminatedPendingRejected)throw Error('terminated Worker left a pending data RPC alive');
      client.close();client=null;
      return {initial,unclean:reopened.opened,clean:clean.opened,metadataRows:inspection.metadataRows,sqlCalls:inspection.sqlCalls,sourceFenced,terminatedPendingRejected,statusMode:status.mode,confirmedThrough:String(status.confirmedThrough),locksRemaining:(await navigator.locks.query()).held.length};
    } catch {throw Error('local facade fixture failed at '+lastStage);} finally {connector?.close();client?.close();await owned?.close();}
  },scope);
  assert.equal(result.locksRemaining,0);
  console.log(JSON.stringify({browser:browser.version(),actualWasm:true,actualPinnedTasknotesIntake:Boolean(tasknotesIntake),actualDedicatedWorker:true,actualOfficialOpfsSqlite:true,actualLocalCoreHelloAndStatus:true,originalNoiseTupleRestored:true,cpSignedMetadataFixture:true,actualCpAuthentication:false,appliedPolicyQualified:false,keyedOrTaskReadsQualified:false,savedQualified:false,productionCustodyQualified:false,physicalDurabilityQualified:false,labAccess:false,result}));
  await context.close();
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
