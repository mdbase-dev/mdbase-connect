// Explicit Linux qualification runner, NOT an automatically skipped CI test.
// First compile the native queued-ts-host-proof example and build this package
// from this checkout, then explicitly run node --test this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants, openSync, closeSync, readSync, writeSync, readFileSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, lstat, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { HostDriver, HostLoop } from '../../dist/host/driver.js';
import { VaultPlatform } from '../../dist/vault/platform.js';
import { checkRelPath, FsError } from '../../dist/vault/types.js';
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function pause() { Atomics.wait(sleepCell, 0, 0, 5); }
function retrySync(fn, deadline) {
  for (;;) { try { return fn(); } catch (e) {
    if (!['EAGAIN','EWOULDBLOCK','ENXIO'].includes(e.code) || Date.now() >= deadline) throw e;
    pause();
  } }
}
function encoded(value) { return JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v); }
class NativeQueuedCore {
  constructor(input, output, loopKick, onDone, onFailure) {
    this.input=input; this.output=output; this.loopKick=loopKick; this.onDone=onDone;this.onFailure=onFailure;
    this.failure=null;
    this.requests=[];this.seen=new Set();this.stages=[];this.buffer=Buffer.alloc(0);this.inFlight=new Set();this.completed=0;
  }
  send(value) {
    const bytes=Buffer.from(encoded(value)+'\n'); let offset=0; const deadline=Date.now()+30000;
    while (offset<bytes.length) offset += retrySync(()=>writeSync(this.input,bytes,offset,bytes.length-offset),deadline);
  }
  response() {
    const deadline=Date.now()+30000;
    for (;;) {
      const newline=this.buffer.indexOf(10);
      if (newline>=0) { const line=this.buffer.subarray(0,newline);this.buffer=this.buffer.subarray(newline+1);return JSON.parse(line.toString()); }
      const bytes=Buffer.alloc(65536);const count=retrySync(()=>readSync(this.output,bytes,0,bytes.length),deadline);
      assert.ok(count>0,'original native owner exited without an actual response');
      this.buffer=Buffer.concat([this.buffer,bytes.subarray(0,count)]);assert.ok(this.buffer.length<=1024*1024,'bounded fixture response');
    }
  }
  poll(nowMs) {
    if(this.failure)return null;
    try{return this.pollOriginal(nowMs);}catch(error){this.fail(error);return null;}
  }
  fail(error) { if(!this.failure){this.failure=error;this.onFailure(error);} }
  pollOriginal(nowMs) {
    // Synchronous FIFO exchange actually polls the ORIGINAL Rust future now;
    // no guessed wake-up, fake Core, reconstructed inventory or completion.
    this.send({op:'Poll',now:nowMs});const response=this.response();
    if (response.preIoReceipt) {
      if (this.preIoReceipt) assert.deepEqual(response.preIoReceipt,this.preIoReceipt,'captured original pre-IO receipt never changes identity');
      else this.preIoReceipt=response.preIoReceipt;
      assert.notEqual(this.preIoReceipt.published,'Published');assert.equal(this.preIoReceipt.hostInFlight,0);assert.ok(this.preIoReceipt.publicationWaits>0);
    }
    for (const {id,op} of response.requests) {
      assert.ok(!this.seen.has(id),'original host operation never restarts');this.seen.add(id);this.inFlight.add(id);
      if ('handle' in op) op.handle=BigInt(op.handle);
      for (const key of ['bytes','expect','new']) if (key in op) op[key]=Uint8Array.from(op[key]);
      this.requests.push([BigInt(id),{kind:'File',op}]);
    }
    if (response.ready) {
      assert.equal(this.inFlight.size,0);this.stages.push(response.stage);
      if (response.stage==='done') this.onDone(response);
      else queueMicrotask(this.loopKick); // An ACTUAL stage completion advances the fixture, not a guessed timer.
    }
    return response.wake;
  }
  takeRequests() { return this.failure?[]:this.requests.splice(0); }
  complete(id,done) {
    // On a failed transport, leave native completion ownership unresolved. The
    // entire qualification FAILS; draining host IO is not a native drain ACK.
    if(this.failure)return;
    try {
      assert.ok(this.inFlight.has(id.toString()),'only original in-flight request may complete');
      this.send({op:'Complete',id:id.toString(),done});this.inFlight.delete(id.toString());this.completed++;
    } catch(error) {this.fail(error);}
  }
}
async function nodeCollection(root) {
  const path=rel=>{ checkRelPath(rel==='/'?'':rel);return resolve(root,rel==='/'?'':rel); };
  const stat=async rel=>{ try { const s=await lstat(path(rel));assert.ok(s.isFile()||s.isDirectory(),'regular owned fixture only');return {type:s.isFile()?'file':'folder',size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs}; } catch(e) {if(e.code==='ENOENT')return null;throw e;} };
  const file=rel=>{try {const s=lstatSync(path(rel));return s.isFile()?{path:rel,stat:{size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs},extension:rel.split('.').pop()}:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const process=async (rel,fn)=>{const old=await readFile(path(rel),'utf8');const next=fn(old);if(next!==old)await writeFile(path(rel),next);return next;};
  const adapter={stat,exists:async rel=>(await stat(rel))!==null,getBasePath:()=>root,
    async list(rel){const entries=await readdir(path(rel),{withFileTypes:true});const prefix=rel==='/'?'':rel;return {files:entries.filter(e=>e.isFile()).map(e=>prefix?`${prefix}/${e.name}`:e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>prefix?`${prefix}/${e.name}`:e.name)};},
    async read(rel){return readFile(path(rel),'utf8');},async readBinary(rel){const b=await readFile(path(rel));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},
    async write(rel,data){await writeFile(path(rel),data);},async writeBinary(rel,data){await writeFile(path(rel),new Uint8Array(data));},process,
    async mkdir(rel){await mkdir(path(rel));},async remove(rel){await unlink(path(rel));},async rename(from,to){await rename(path(from),path(to));},
  };
  const unsupported=()=>{throw new FsError('Unsupported','unused qualification-only operation');};
  const vault={adapter,getAbstractFileByPath:file,process:async (f,fn)=>process(f.path,fn),
    async create(rel,text){await writeFile(path(rel),text,{flag:'wx'});return file(rel);},async createBinary(rel,bytes){await writeFile(path(rel),new Uint8Array(bytes),{flag:'wx'});return file(rel);},
    async rename(f,to){await rename(path(f.path),path(to));},on:unsupported,offref:unsupported};
  const app={vault,fileManager:{trashFile:async f=>unlink(path(f.path))}};
  const platform=new VaultPlatform(app,{root:'',platform:{isMobileApp:false,isAndroidApp:false,isIosApp:false},wholeFileRangeMaxBytes:1024*1024});
  const journal={load:unsupported,append:unsupported,compact:unsupported};
  return {platform,driver:new HostDriver(platform,journal,null)};
}
const outsideDocument='OUTSIDE physical writer won the original create race.\n';
async function qualify(mode) {
  assert.equal(process.platform,'linux','this synchronous owned FIFO fixture qualifies Linux only');
  const binary=join(repo,'target/debug/examples/queued-ts-host-proof');assert.ok(lstatSync(binary).isFile(),'fresh rcargo-built fixture executable required; no silent skip');
  const work=join(repo,'target/obsidian-host-joined');await mkdir(work,{recursive:true});const root=await mkdtemp(join(work,'joint-host-'));
  console.log(`OWNED_JOINT_FIXTURE_ROOT=${root}`);
  await writeFile(join(root,'fixture-owner'),'queued-ts-host-proof-v1');const collection=join(root,'collection');await mkdir(collection);
  const bundle=JSON.parse(await readFile(join(repo,'crates/local-host/tests/fixtures/reader-semantic-digests/bundle.json'),'utf8'));assert.equal(bundle.resources.length,8);
  for(const r of bundle.resources){checkRelPath(r.path);await mkdir(resolve(collection,r.path,'..'),{recursive:true});await writeFile(join(collection,r.path),r.document);}
  const toCore=join(root,'to-core'),fromCore=join(root,'from-core');const fifo=spawnSync('mkfifo',[toCore,fromCore]);assert.equal(fifo.status,0);
  const stderr=openSync(join(root,'native.stderr'),'wx');const native=spawn(binary,[root,mode==='wrong-parent'?'success':mode],{stdio:['ignore','ignore',stderr]});closeSync(stderr);
  let exitCode;const exited=new Promise((resolve,reject)=>{native.once('error',reject);native.once('exit',(code,signal)=>{exitCode=code;resolve({code,signal});});});
  const output=openSync(fromCore,constants.O_RDONLY|constants.O_NONBLOCK);
  const input=retrySync(()=>openSync(toCore,constants.O_WRONLY|constants.O_NONBLOCK),Date.now()+30000);
  const {platform,driver}=await nodeCollection(collection);
  let loop;let result;let resolveDone;let rejectDone;const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const failed=error=>{error.fixtureRoot=root;rejectDone(error);};
  const core=new NativeQueuedCore(input,output,()=>loop.kick(),response=>{result=response;resolveDone();},failed);
  void exited.then(({code,signal})=>{if(!result)failed(new Error(`original native owner exited before qualification: code=${code}, signal=${signal}; ${readFileSync(join(root,'native.stderr'),'utf8')}`));},failed);
  const trace=[];let outsideWon=false;
  loop=new HostLoop(core,async op=>{
    trace.push(op.op.op);
    if(op.op.op==='GuardedCreate'&&op.op.path==='notes/original.md') {
      assert.equal(await platform.perform({op:'Stat',path:'notes/original.md'}).then(r=>r.ok),false,'pending native batch has not fabricated physical publication');
      if(mode==='cas-drift') { assert.equal(outsideWon,false);await mkdir(join(collection,'notes'),{recursive:true});await writeFile(join(collection,'notes/original.md'),outsideDocument,{flag:'wx'});outsideWon=true; }
      if(mode==='wrong-parent')await writeFile(join(collection,'notes'),'OUTSIDE blocking parent',{flag:'wx'});
    }
    return driver.perform(op);
  });
  try {
    loop.start();await done;await loop.stop();await platform.closeRangeReads();
    assert.equal(core.inFlight.size,0);assert.equal(core.completed,core.seen.size);assert.deepEqual(core.stages,['opening','rescan','publication','done']);
    assert.equal(result.resources.length,8);assert.equal(result.contracts.length,3);assert.equal(result.originalIntents,1);assert.equal(result.inFlight,0);
    for(const r of bundle.resources){const witness=result.resources.find(w=>w.path===r.path);assert.ok(witness.confirmed);assert.equal(witness.document,r.document);assert.equal(witness.revision,hash(Buffer.from(r.document)));assert.equal((await readFile(join(collection,r.path))).toString(),r.document);}
    const expected={ 'dev.mdbase.reader.source':'59b1f75352086bc76adb3f0dd50150ae437a63d9562139a74be5f6eaac778bec','dev.mdbase.reader.annotation':'9593376fed19903b07013ce0167b1d25ff0517364c826ddb8ecf3b4b7d83ef7c','mdbase.view':'0918acefce08cddd778fab768fe4f2e4615d263a0eec3e5330b6897c686d744e'};
    for(const contract of result.contracts){assert.equal(contract.digest,expected[contract.id]);assert.ok(contract.implementedBy.length>0);}
    assert.equal(result.record.mutation,core.preIoReceipt.mutation);assert.equal(result.record.id,core.preIoReceipt.id);
    assert.equal(result.record.mutation,result.record.receiptMutation);assert.match(result.record.id,/^[0-9a-f]{32}$/);assert.match(result.record.mutation,/^[0-9a-f]{32}$/);assert.equal(result.record.confirmed,true);
    if(mode==='success') {
      assert.equal(result.outcome,'published');assert.equal(result.record.published,true);
      assert.equal(result.record.revision,hash(Buffer.from(result.record.document)));assert.equal((await readFile(join(collection,'notes/original.md'))).toString(),result.record.document);
    } else {
      assert.equal(outsideWon,true);assert.equal(result.outcome,'cas-drift');assert.equal(result.record.published,false);
      assert.equal((await readFile(join(collection,'notes/original.md'))).toString(),outsideDocument,'original CAS drift must not clobber outside bytes');
    }
    assert.ok(trace.includes('GuardedCreate'));assert.ok(trace.includes('OpenRangeRead'));assert.ok(trace.includes('CloseRangeRead'));
    assert.deepEqual(await exited,{code:0,signal:null});
    const sources=['crates/local-host/examples/queued-ts-host-proof.rs','crates/local-host/examples/queued-ts-host-proof/transport.rs','packages/obsidian-runtime/src/host/driver.ts','packages/obsidian-runtime/src/vault/platform.ts','packages/obsidian-runtime/src/vault/wholeFileRange.ts'];
    const evidence={...result,nativeExecutableSha256:hash(readFileSync(binary)),sources:Object.fromEntries(sources.map(path=>[path,hash(readFileSync(join(repo,path)))])),hostOperations:core.completed,trace,root};await writeFile(join(root,'qualification.json'),JSON.stringify(evidence,null,2));
    console.log(`JOINED_TS_HOST_FILESTORE=8-original/3-native-contracts/original-MID/${result.outcome}; evidence=${root}/qualification.json`);
  } finally {
    await loop.stop();await platform.closeRangeReads();closeSync(input);closeSync(output);
    if(exitCode===undefined){native.kill('SIGTERM');await exited;}
  }
}
test('actual TS HostLoop/HostDriver/VaultPlatform + native FileStore startup and original write/read', {timeout:90000}, ()=>qualify('success'));
test('actual TS host CAS drift keeps original MID NotPublished and preserves outside bytes', {timeout:90000}, ()=>qualify('cas-drift'));
test('qualification fails closed on actual wrong-kind physical parent and cleans up the owned child', {timeout:90000}, async ()=>{
  let failure;
  await assert.rejects(qualify('wrong-parent'),error=>{failure=error;return error instanceof Error;});
  assert.ok(failure.fixtureRoot);
  assert.match(await readFile(join(failure.fixtureRoot,'native.stderr'),'utf8'),/ENOTDIR|WrongKind/,'the ORIGINAL native operation failed on the actual physical parent');
  assert.equal(await readFile(join(failure.fixtureRoot,'collection/notes'),'utf8'),'OUTSIDE blocking parent');
  assert.equal(await lstat(join(failure.fixtureRoot,'qualification.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}),false,'failed native work NEVER produces successful qualification evidence');
});
