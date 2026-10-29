// Actual Worker handler + Engine WASM + DO SQLite/storage.sync. Recorded, signed
// PUBLIC fixed fixture only. Not managed KMS/custody or LAB acceptance evidence.
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const [log,wasmPath,scratchRoot]=process.argv.slice(2);assert(log&&wasmPath&&scratchRoot);
const matches=[...(await readFile(log,'utf8')).matchAll(/^MODE_WORKER_FIXTURE=(.*)$/gm)];assert.equal(matches.length,1);
const f=JSON.parse(matches[0][1]);assert.equal(f.publicFixedTestValuesOnly,true);
await mkdir(scratchRoot,{recursive:true});const scratch=await mkdtemp(scratchRoot+'/mode-workerd-');process.env.TMPDIR=scratch;
const source=`
import {HostedCollection} from './src/worker.ts';
import {Engine,encode,decode} from './src/engine.ts';
const f=${JSON.stringify(f)};const token='public-mode-fixture'.repeat(4);
const bytes=s=>Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));
export class ModeProbe extends HostedCollection {
 async ready(collection){
  if(this.engine)return this.engine;
  this.collection=collection;this.engine=new Engine(this.ctx.storage);this.engine.open(bytes(f.config));this.engine.logBind();
  await this.sync(this.engine);await this.ctx.storage.put('collection-mode-device',f.device);await this.ctx.storage.sync();return this.engine;
 }
 async sync(engine){
  if(!engine.logBound)engine.logBind(); // Same bind boundary as the real HTTP pump.
  const phase=await this.ctx.storage.get('fixture-phase');const items=phase==='private'?f.private:phase==='unkeyed'?f.unkeyed:f.cloud;
  const raw=items.map(bytes),head=raw.length,hash=async b=>new Uint8Array(await crypto.subtle.digest('SHA-256',b));
  const domain=new TextEncoder().encode('mdbase/v1/chain'),last=raw.at(-1),input=new Uint8Array(1+domain.length+last.length);input[0]=domain.length;input.set(domain,1);input.set(last,1+domain.length);const chain=await hash(input);
  for(let tick=0;tick<16;tick++){this.engine.tick(Date.now());for(let turn=0;turn<64;turn++){
   const calls=this.engine.logCalls();if(!calls.length)break;
   for(const call of calls){const frame=decode(call.frame),method=frame.get(2),p=frame.get(3);let result;
    if(method==='head')result=new Map([[0,head],[1,chain],[2,1]]);
    else if(method==='read')result=new Map([[0,raw.map((b,i)=>[i+1,b]).filter(([n,b])=>n>p.get(1)&&(p.get(3)!==1||decode(b).get(1)!==1))],[1,head],[2,chain],[3,1],[4,false],[6,false]]);
    else throw Error('unexpected native log effect '+method);
    this.engine.logReply(call.id,encode(new Map([[0,1],[1,frame.get(1)],[2,result]])));call.frame.fill(0);
   }
  }}
  await this.ctx.storage.sync();
 }
 async fetch(request){const op=new URL(request.url).searchParams.get('op');
  if(op==='unkeyed'||op==='cloud'){await this.ctx.storage.put('fixture-phase',op);return Response.json({ok:true});}
  if(op==='private'){await this.ctx.storage.put('fixture-phase','private');const e=await this.ready(f.collection);e.refresh();await this.sync(e);return Response.json({ok:true});}
  if(op==='ledger'){await this.ctx.storage.put('migration-run',{id:'public-preserved-ledger'});return Response.json({ok:true});}
  if(op==='inspect'){return Response.json({ledger:await this.ctx.storage.get('migration-run'),marker:await this.ctx.storage.get('collection-mode-device'),live:!!this.engine});}
  if(op==='evict'){if(this.engine)this.engine.close();this.engine=null;return Response.json({ok:true});}
  const fault=new URL(request.url).searchParams.get('fault');
  if(fault==='before-delete'||fault==='after-delete'){
   const storage=this.ctx.storage,original=storage.delete.bind(storage);let once=true;
   storage.delete=async(...args)=>{if(once){once=false;if(fault==='before-delete')throw Error('fixture pre-effect crash');await original(...args);await storage.sync();throw Error('fixture lost physical acknowledgement');}return original(...args);};
   try{return await super.fetch(request);}finally{storage.delete=original;}
  }
  return super.fetch(request);
 }
}
export default {fetch(request,env){return env.COLLECTIONS.get(env.COLLECTIONS.idFromName(f.collection)).fetch(request)}};
`;
const compiled=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../',import.meta.url)),sourcefile:'public-mode-workerd.ts',loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,external:['cloudflare:workers'],plugins:[{name:'wasm',setup(b){b.onResolve({filter:/hosted\.wasm$/},()=>({path:'hosted.wasm',external:true}));}}]});
const wasm=await readFile(wasmPath);
const options=()=>convertV4MiniflareOptions({name:'mode-native',modules:[{type:'ESModule',path:'worker.js',contents:compiled.outputFiles[0].text},{type:'CompiledWasm',path:'hosted.wasm',contents:wasm}],compatibilityDate:'2026-10-05',port:0,bindings:{HOSTED_SERVICE_TOKEN:'public-mode-fixture'.repeat(4)},durableObjects:{COLLECTIONS:{className:'ModeProbe',useSQLite:true}},resourcePersistencePath:scratch+'/persist',resourceTmpPath:scratch+'/tmp',outboundService:()=>new Response('no fixture network',{status:503})});let mf=new Miniflare(options());
const token='public-mode-fixture'.repeat(4),input={collection:f.collection,device:f.device,epoch:String(f.epoch??1),challenge:'aa'.repeat(32)};
const call=(path,body=input,auth=token,fault='')=>mf.dispatchFetch('http://fixture.test/v1/hosted/collection-mode/'+path+'?collection='+f.collection+(fault?'&fault='+fault:''),{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)});
const op=name=>mf.dispatchFetch('http://fixture.test/?op='+name);
try{
 assert.equal((await call('ready',input,'wrong')).status,401);
 await op('unkeyed');assert.equal((await call('ready')).status,503,'CP activation can open the actor before owner grants exist');
 await op('cloud'); // A commits grants later; no actor restart or synthetic head push.
 const deadline=Date.now()+6000;let warm;
 do{warm=await call('ready');if(warm.status===200)break;await new Promise(resolve=>setTimeout(resolve,1100));}while(Date.now()<deadline);
 assert.equal(warm.status,200,'warm readiness must fetch the new signed owner grant and history without restarting or bypassing the bounded key probe');
 // Discard one readiness acknowledgement, then restart the actual runtime.
 // Retry must re-observe native custody, not a persisted host ready flag.
 await call('ready');await mf.dispose();mf=new Miniflare(options());
 const observed=await call('ready',{...input,challenge:'bb'.repeat(32)});assert.equal(observed.status,200);assert.equal((await observed.json()).challenge,'bb'.repeat(32));
 assert.equal((await call('ready',{...input,epoch:String(BigInt(input.epoch)+1n)})).status,503,'wrong epoch is not readiness');
 await op('ledger');
 assert.equal((await call('retire',{...input,device:'11111111-1111-4111-8111-111111111111'})).status,503,'stale identity cannot erase fresh cache');
 assert.equal((await call('ready')).status,200);
 await op('private');assert.equal((await call('ready')).status,503,'actual revoked service is not ready');
 assert.equal((await call('retire',{...input,epoch:'2'})).status,200);
 let state=await (await op('inspect')).json();assert.equal(state.live,false);assert.deepEqual(state.ledger,{id:'public-preserved-ledger'});
 assert.equal((await call('retire',{...input,epoch:'2'})).status,200,'lost retirement reply retry is idempotent');
 await mf.dispose();mf=new Miniflare(options());assert.equal((await call('retire',{...input,epoch:'2'})).status,200,'actual cold workerd restart retains identity evidence');
 state=await(await op('inspect')).json();assert.deepEqual(state.ledger,{id:'public-preserved-ledger'});
 for(const fault of ['before-delete','after-delete']){
  await op('private');
  assert.equal((await call('retire',{...input,epoch:'2'},token,fault)).status,503,`${fault}: no completion acknowledgement on uncertainty`);
  await mf.dispose();mf=new Miniflare(options());
  assert.equal((await call('retire',{...input,epoch:'2'})).status,200,`${fault}: cold retry settles idempotently`);
  state=await(await op('inspect')).json();assert.equal(state.live,false);assert.deepEqual(state.ledger,{id:'public-preserved-ledger'});
  assert.equal((await call('ready')).status,503,`${fault}: old service cannot revive readiness`);
 }
 console.log('PASS: real Worker/Engine/SQLite readiness, revocation, stale-identity refusal, warm/cold retries, physical-effect crash/lost-ack matrix and ledger retention');
}finally{await mf.dispose();await rm(scratch,{recursive:true,force:true});}
