// Owned LOOPBACK fixture only: real SDK/WASM/SQLite/HTTP log and native peers.
// Public conformance keys/tokens, never managed identities or release evidence.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import * as client from '../dist/index.js';
import * as app from '../dist/app-host/index.js';
import * as storage from '../dist/app-storage/index.js';
import {openNativeServiceFixture} from './app-cloud-copy-service-fixture.mjs';
const [fixture,wasmPath]=process.argv.slice(2);assert(fixture&&wasmPath);
const f=JSON.parse(await readFile(fixture,'utf8'));
assert.equal(f.publicConformanceFixture,true);assert.match(f.log,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const bytes=s=>new Uint8Array(Buffer.from(s,'hex'));
const sdk={...client,...app,...storage};
const native=await openNativeServiceFixture({sdk,wasm:await readFile(wasmPath),collection:f.collection,expectedGenesis:'sha256:'+Buffer.from(f.genesis).toString('hex'),roots:[bytes(f.root)],policyPins:bytes(f.pins),logOrigin:f.log,log:{mintToken:()=>f.token},service:{deviceId:f.device,signSecret:bytes(f.sign),kemSecret:bytes(f.kem),signPublic:bytes(f.signPublic)}});
let busy=false,error=null;
const timer=setInterval(()=>{if(busy)return;busy=true;native.drive().catch(e=>{error=e;}).finally(()=>{busy=false;});},40);
let api;
async function until(work){const end=Date.now()+45000;for(;;){if(error)throw error;try{return await work();}catch(e){if(Date.now()>end)throw e;await pause(100);}}}
async function stage(name,path){await until(async()=>{const records=(await api.query({limit:100},undefined,AbortSignal.timeout(3000))).records;assert(records.some(r=>r.path===path),`SDK must read ${path}`);});const write=await api.create({path:`sdk-${name}.md`,document:`written by SDK in ${name}\n`});await write.confirmed;await writeFile(f.stage, name);}
try{
 api=await client.connect({connector:client.inProcessConnector(native.runtime),app:{name:'public-mode-fixture',version:'1'},reconnect:false,signal:AbortSignal.timeout(15000)});
 await stage('cloud','cloud.md');
 for(const [name,path] of [['private','private.md'],['cloud-again','cloud-again.md']]){
   await until(async()=>assert.equal(await readFile(f.command,'utf8'),name));
   await stage(name,path);
 }
 console.log('PASS: actual SDK reads/writes through Cloud -> Private -> Cloud with native daemon peers');
}finally{clearInterval(timer);api?.close();while(busy)await pause(10);await native.close();}
