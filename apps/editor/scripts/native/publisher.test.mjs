// Public data and transport doubles; no deployment or credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';
import { assertDispatch, assertCheckout, assertAncestor, deploymentFor } from './refs.mjs';
import { loadOriginals, productionPin, compareInstalled, protectedHashes } from './originals.mjs';
import { authenticateProduction, stagingArchive } from './authentication.mjs';
import { prepareInstall } from './install-inputs.mjs';
import { capturePrevious, rollback } from './rollback.mjs';
import { assertArtifactMetadata, assertArtifactRun, assertArtifactDirectory } from './artifact.mjs';
import { inventoryDirectory } from './native-publish-bytes.mjs';
import { headersPolicy, redirectsPolicy, assertHostingSource, verifyHosting, verifyPublication } from './hosting.mjs';
import { assertBuiltManifest, captureDeployment, createReceipt } from './publisher.mjs';
const repoRoot=fileURLToPath(new URL('../../../../',import.meta.url));
const hashes={EDITOR_TRUST_ASSET_SHA256:'7912e40838213e60b65848350d319a48019021317b112e3326429b250f0133d7'};
const source='a'.repeat(40),tree='b'.repeat(40),origin='https://editor-staging.mdbase.dev';
const uuid='12345678-1234-4234-8234-123456789abc';
const env={TARGET:'staging',SOURCE_SHA:source,GITHUB_SHA:tree,GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch'};
const expected={id:'10',digest:'sha256:'+'c'.repeat(64),repository:'mdbase-dev/mdbase-connect',repositoryId:'20',run:'30',attempt:'1',event:'workflow_dispatch',ref:env.GITHUB_REF,workflowSha:tree,source,tree,target:'staging'};
const metadata={id:10,expired:false,digest:expected.digest,name:'editor-native-build-staging-30-1',workflow_run:{id:30,head_sha:tree,head_repository_id:20}};
const run={id:30,head_sha:tree,run_attempt:1,event:expected.event,head_branch:'main',path:'.github/workflows/editor-pages.yml',repository:{id:20,full_name:expected.repository}};
const deployment={id:uuid,url:'https://12345678.mdbase-editor.pages.dev',sourceSha:source,pagesBranch:'staging'};
const sha=b=>createHash('sha256').update(b).digest('hex');

it('admits an exact clean ancestor even when main and the dispatch SHA move ahead',async()=>{
 const root=await mkdtemp(join(tmpdir(),'editor-ancestry-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git('init');git('config','user.email','test@example.invalid');git('config','user.name','Test');
  git('commit','--allow-empty','-m','source');const sha=git('rev-parse','HEAD');
  git('commit','--allow-empty','-m','main advanced');git('update-ref','refs/remotes/origin/main','HEAD');
  git('checkout','--detach',sha);
  const binding=assertDispatch({...env,SOURCE_SHA:sha});
  assert.equal(assertCheckout(binding,root).sha,sha);
  git('checkout','--orphan','unrelated');git('commit','--allow-empty','-m','not main');
  const other=git('rev-parse','HEAD');
  assert.throws(()=>assertCheckout({...binding,sha:other},root),/ancestor/);
  assert.throws(()=>assertAncestor({...binding,sha:other},root),/ancestor/);
  for(const patch of [{SOURCE_SHA:'abcd'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/tags/v1'},{TARGET:'lab'}])assert.throws(()=>assertDispatch({...env,...patch}));
 }finally{await rm(root,{recursive:true,force:true});}
});
async function originalsFixture() {
 const root=await mkdtemp(join(tmpdir(),'editor-originals-')),app=join(root,'apps/editor');
 await mkdir(app,{recursive:true});
 await cp(join(repoRoot,'apps/editor/vendor'),join(app,'vendor'),{recursive:true});
 await cp(join(repoRoot,'config'),join(root,'config'),{recursive:true});
 const pkg=JSON.parse(await readFile(join(repoRoot,'apps/editor/package.json'),'utf8'));
 await writeFile(join(app,'package.json'),JSON.stringify(pkg));
 let lock=await readFile(join(repoRoot,'pnpm-lock.yaml'),'utf8');
 const uiDir=join(root,'ui/package');await mkdir(uiDir,{recursive:true});
 await writeFile(join(uiDir,'package.json'),JSON.stringify({name:'@mdbase-dev/ui',version:pkg.dependencies['@mdbase-dev/ui']}));
 await writeFile(join(uiDir,'index.js'),'export const value=1;');
 const ui=execFileSync('tar',['-czf','-','-C',join(root,'ui'),'package']);
 const integrity='sha512-'+createHash('sha512').update(ui).digest('base64');
 const entry=lock.split(`\n  '@mdbase-dev/ui@${pkg.dependencies['@mdbase-dev/ui']}':\n`)[1].split(/\n  [^ ]/)[0];
 lock=lock.replace(entry,entry.replace(/sha512-[A-Za-z0-9+/]+=*/,integrity));
 await writeFile(join(root,'pnpm-lock.yaml'),lock);
 for(const [name,bytes] of [['@mdbase-dev/sdk',(await productionPin(root)).bytes],['@mdbase-dev/ui',ui],
  ['@mdbase-dev/connect-protocol',await readFile(join(app,pkg.dependencies['@mdbase-dev/connect-protocol'].slice(5)))]]) {
  const installed=join(app,'node_modules',name);await mkdir(installed,{recursive:true});
  execFileSync('tar',['-xzf','-','--strip-components=1','-C',installed],{input:bytes});
 }
 const options={target:'production',repoRoot:root,hashes,fetchImpl:async()=>new Response(ui),
  authenticate:async()=>({kind:'test-double'})};
 return {root,app,options};
}
it('binds current repin metadata, frozen SDK/UI/protocol pins and every installed original member',async()=>{
 const f=await originalsFixture();
 try {
  const plan=await loadOriginals({...f.options,installed:true});
  assert.equal(plan.release.assetSha256,hashes.EDITOR_TRUST_ASSET_SHA256);
  assert.throws(()=>protectedHashes({}),/EDITOR_TRUST/);
  await assert.rejects(loadOriginals({...f.options,hashes:{EDITOR_TRUST_ASSET_SHA256:'0'.repeat(64)}}),/protected trust hash/);
  const {pin}=await productionPin(f.root);
  await writeFile(join(f.app,'vendor',pin.artifact),'wrong archive');
  await assert.rejects(loadOriginals(f.options),/committed SDK archive mismatch/);
  await cp(join(repoRoot,'apps/editor/vendor',pin.artifact),join(f.app,'vendor',pin.artifact));
  const path=join(f.app,'node_modules/@mdbase-dev/ui/index.js');
  await writeFile(path,'changed');
  await assert.rejects(compareInstalled(f.root,plan.archives,{fetchImpl:f.options.fetchImpl}),/ALL installed/);
  await rm(path);await assert.rejects(compareInstalled(f.root,plan.archives,{fetchImpl:f.options.fetchImpl}),/ALL installed/);
  await writeFile(path,'export const value=1;');await writeFile(join(f.app,'node_modules/@mdbase-dev/ui/extra'),'extra');
  await assert.rejects(compareInstalled(f.root,plan.archives,{fetchImpl:f.options.fetchImpl}),/ALL installed/);
  await assert.rejects(loadOriginals({...f.options,fetchImpl:async()=>new Response('wrong UI')}),/UI registry archive integrity/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('checks exact npm integrity and authenticated publisher source before accepting the production archive',async()=>{
 const {pin,bytes}=await productionPin(repoRoot);
 const options={fetchImpl:async()=>Response.json({name:'@mdbase-dev/sdk',version:pin.version,dist:{integrity:pin.sri}}),
  prove:async(name,baseline)=>{assert.equal(name,'@mdbase-dev/sdk');assert.equal(baseline.workflow,'publish-sdk-npm.yml');return {commit:pin.sourceCommit,identity:`https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml@${pin.publication.ref}`};}};
 await authenticateProduction(pin,bytes,options);
 await assert.rejects(authenticateProduction(pin,Buffer.from('wrong'),options),/integrity/);
 await assert.rejects(authenticateProduction(pin,bytes,{...options,prove:async()=>({commit:source})}),/source mismatch/);
 await assert.rejects(authenticateProduction(pin,bytes,{...options,prove:async()=>{throw Error('bad certificate');}}),/certificate/);
});
it('pins staging to the production version and verifies both release digests and the repository/workflow/source attestation',async()=>{
 const {pin}=await productionPin(repoRoot),bytes=Buffer.from('staging'),proof=Buffer.from('{}');
 const prefix=`https://github.com/mdbase-dev/mdbase-connect/releases/download/sdk-v${pin.version}/`;
 const release={tag_name:'sdk-v'+pin.version,prerelease:true,draft:false,assets:[
  {name:'sdk-staging.tgz',digest:'sha256:'+sha(bytes),browser_download_url:prefix+'sdk-staging.tgz'},
  {name:'sdk-staging.tgz.sigstore.json',digest:'sha256:'+sha(proof),browser_download_url:prefix+'sdk-staging.tgz.sigstore.json'}]};
 let called=false;
 const options={fetchImpl:async url=>url.includes('api.github.com')?Response.json(release):new Response(url.endsWith('.json')?proof:bytes),
  run:(command,args)=>{called=true;assert.equal(command,'gh');assert.ok(args.includes('--bundle'));assert.ok(args.includes(pin.sourceCommit));assert.ok(args.includes('mdbase-dev/mdbase-connect/.github/workflows/publish-sdk-npm.yml'));}};
 assert.equal((await stagingArchive(pin,options)).authentication.sha256,sha(bytes));assert.equal(called,true);
 await assert.rejects(stagingArchive(pin,{...options,fetchImpl:async url=>url.includes('api.github.com')?Response.json(release):new Response('wrong')}),/digest mismatch/);
 await assert.rejects(stagingArchive(pin,{...options,run:()=>{throw Error('invalid signature');}}),/attestation verification failed/);
});
it('derives the staging frozen install without changing any other dependency',async()=>{
 const f=await originalsFixture();
 try {
  const plan={target:'staging',sdkTrust:await loadOriginals(f.options)};
  const originalLock=await readFile(join(f.root,'pnpm-lock.yaml'),'utf8');
  const originalPackage=JSON.parse(await readFile(join(f.app,'package.json'),'utf8'));
  const bytes=Buffer.from('authenticated staging archive');
  plan.sdkTrust.archives.sdk={path:'https://example.invalid/sdk-staging.tgz',sha256:sha(bytes),sri:'sha512-staging'};
  await prepareInstall(plan,f.root,async()=>new Response(bytes));
  const pkg=JSON.parse(await readFile(join(f.app,'package.json'),'utf8'));
  assert.equal(pkg.dependencies['@mdbase-dev/sdk'],'file:vendor/sdk-staging.tgz');
  const lock=await readFile(join(f.root,'pnpm-lock.yaml'),'utf8');
  assert.ok(lock.includes('sha512-staging'));assert.ok(!lock.includes(plan.sdkTrust.production.sri));
  const stagingPath='file:apps/editor/vendor/sdk-staging.tgz',alias='@mdbase-dev/sdk-staging@'+stagingPath;
  assert.equal(parse(lock).importers['apps/editor'].dependencies['@mdbase-dev/sdk'].version,alias);
  const restored=lock.replaceAll("version: '"+alias+"'",'version: '+stagingPath)
   .replaceAll("'@mdbase-dev/sdk': '"+alias+"'","'@mdbase-dev/sdk': "+stagingPath)
   .replaceAll(alias,'@mdbase-dev/sdk@'+stagingPath)
   .replaceAll('sdk-staging.tgz',plan.sdkTrust.production.path.split('/').at(-1))
   .replaceAll('sha512-staging',plan.sdkTrust.production.sri);
  assert.equal(restored,originalLock,'only the SDK file alias, integrity and peer identity change');
  pkg.dependencies['@mdbase-dev/sdk']=originalPackage.dependencies['@mdbase-dev/sdk'];
  assert.deepEqual(pkg,originalPackage);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('rolls production back, verifies the previous id and every transitive asset, and keeps failure evidence',async()=>{
 const previousId='87654321-1234-4234-8234-123456789abc',previousUrl='https://87654321.mdbase-editor.pages.dev',failedId='12345678-1234-4234-8234-123456789abc';
 let active=previousId,commit=null;const calls=[];
 const source='c'.repeat(40),clock={t:0,now:()=>clock.t,sleep:async ms=>{clock.t+=ms;}},recovery={source,...clock};
 const bodies={'/':'<script type="module" src="/assets/entry.js"></script><link href="/style.css" rel="stylesheet">','/assets/entry.js':'import("./chunk.js");fetch("assets/engine.wasm");fetch("./gone.wasm");new URL("./workers.v1/pool.js",import.meta.url)','/assets/chunk.js':'new URL("worker.js",import.meta.url)','/assets/engine.wasm':'previous wasm','/assets/worker.js':'previous worker','/assets/workers.v1/pool.js':'previous pool','/style.css':'previous style'};
 const options={accountId:'a'.repeat(32),apiToken:'test-double',fetchImpl:async(url,init)=>{
  calls.push({url,method:init.method});
  if(url.includes('/rollback')){active=previousId;return Response.json({success:true,result:{id:previousId}});}
  if(url.includes('api.cloudflare.com'))return Response.json({success:true,result:{name:'mdbase-editor',production_branch:'main',canonical_deployment:{id:active,url:previousUrl,environment:'production',deployment_trigger:{metadata:{commit_hash:commit}}}}});
  const path=new URL(url).pathname;
  if(path.endsWith('.json'))return new Response('manifest');
  if(path.endsWith('.wasm') && !bodies[path])return new Response('<html>spa</html>',{headers:{'content-type':'text/html'}});
  return new Response(bodies[path]??'previous asset');
 }};
 const previous=await capturePrevious(options);
 for(const path of ['/assets/entry.js','/assets/chunk.js','/assets/worker.js','/assets/workers.v1/pool.js','/assets/engine.wasm','/style.css'])assert.ok(previous.probes.some(p=>p.path===path),path);
 assert.ok(!previous.probes.some(p=>p.path==='/assets/gone.wasm'),'SPA fallback is not a build asset');
 const plan={target:'production',origin:'https://editor.mdbase.dev'};
 active=failedId;commit=source;
 const report=await rollback(previous,options,recovery);
 assert.equal(report.ok,true);assert.equal(report.restored,true);assert.equal(report.previousId,previousId);
 assert.equal(calls.filter(c=>c.method==='POST').length,1);
 assert.equal(createReceipt({plan,verification:{ok:false},previous,rollback:report}).rollback.ok,true);
 const untouched=await rollback(previous,options,recovery);
 assert.equal(untouched.ok,true);assert.equal(untouched.restored,false);
 assert.equal(calls.filter(c=>c.method==='POST').length,1,'nothing to undo when the previous deployment is active');
 active=failedId;commit='d'.repeat(40);
 const newer=await rollback(previous,options,recovery);
 assert.equal(newer.ok,false);assert.equal(newer.refused,true);
 assert.equal(calls.filter(c=>c.method==='POST').length,1,'a newer publication is never undone');
 active=previousId;commit=source;
 let reads=0;
 const late=await rollback(previous,{...options,fetchImpl:async(url,init)=>{
  if(url.endsWith('/mdbase-editor') && ++reads===2)active=failedId;
  return options.fetchImpl(url,init);
 }},recovery);
 assert.equal(late.ok,true);assert.equal(late.restored,true,'an upload that lands during verification is still undone');
 assert.equal(active,previousId);
 for(const probe of previous.probes) {
  const broken=await rollback(previous,{...options,fetchImpl:async(url,init)=>url===plan.origin+probe.path?new Response('wrong bytes'):options.fetchImpl(url,init)},{source,settleMs:100});
  assert.equal(broken.ok,false,'rollback must match '+probe.path);
 }
 const staleHeaders=(path,type)=>async(url,init)=>{
  if(url!==plan.origin+path)return options.fetchImpl(url,init);
  const response=await options.fetchImpl(url,init);
  return new Response(response.body,{headers:{'content-type':type,'content-security-policy':"default-src 'self'"}});
 };
 assert.equal((await rollback(previous,{...options,fetchImpl:staleHeaders('/assets/engine.wasm','application/wasm')},recovery)).ok,true,'unchanged bytes may keep another build\'s headers at the edge');
 const htmlPrevious={...previous,probes:previous.probes.map(p=>p.path==='/'?{...p,headers:{...p.headers,'content-type':'text/html'}}:p)};
 assert.equal((await rollback(htmlPrevious,{...options,fetchImpl:staleHeaders('/','text/html')},{source,settleMs:100})).ok,false,'documents must match exactly');
 await assert.rejects(capturePrevious({...options,fetchImpl:async(url,init)=>url===plan.origin+'/assets/entry.js'?new Response('missing',{status:404}):options.fetchImpl(url,init)}),/bytes unavailable/);
 assert.equal(createReceipt({plan,verification:{ok:false},previous,rollback:report}).status,'failed-or-incomplete');
});
it('binds immutable artifact metadata AND the exact workflow/run attempt/manual ref',()=>{
 assertArtifactMetadata(metadata,expected);assertArtifactRun(run,expected);
 for(const patch of [{expired:true},{digest:'sha256:'+'d'.repeat(64)},{name:'editor-native-build-staging-30-2'},{workflow_run:{...metadata.workflow_run,head_repository_id:99}}])assert.throws(()=>assertArtifactMetadata({...metadata,...patch},expected));
 for(const patch of [{run_attempt:2},{event:'push'},{head_branch:'other'},{path:'.github/workflows/native-journal.yml'},{head_sha:source}])assert.throws(()=>assertArtifactRun({...run,...patch},expected));
});
it('uses page20 and resolves only the unique uploaded URL/full source/channel to a FULL UUID',async()=>{
 const entry={id:uuid,url:deployment.url,deployment_trigger:{metadata:{commit_hash:source,branch:'staging'}}};
 const options={output:'Success '+deployment.url,target:'staging',sha:source,accountId:'a'.repeat(32),apiToken:'fixture'};
 const capture=rows=>captureDeployment({...options,fetchImpl:async url=>{assert.match(url,/\/mdbase-editor\/deployments\?per_page=20$/);return Response.json({success:true,result:rows});}});
 assert.deepEqual(await capture([entry]),deployment);
 // Re-uploading identical source is not a source conflict: identify the new URL.
 const prior={...entry,id:'87654321-1234-4234-8234-123456789abc',url:'https://87654321.mdbase-editor.pages.dev'};
 assert.deepEqual(await capture([entry,prior]),deployment);
 for(const bad of [{...entry,id:'12345678'},{...entry,url:'https://87654321.mdbase-editor.pages.dev'},
  {...entry,deployment_trigger:{metadata:{commit_hash:tree,branch:'staging'}}},{...entry,deployment_trigger:{metadata:{commit_hash:source,branch:'main'}}}])await assert.rejects(capture([bad]),/UUID/);
 await assert.rejects(capture([entry,entry]),/UUID/);
});
for(const target of ['staging','production']) it(`retains BOTH ${target} callbacks and refuses retargeted installations`,()=>{
 const {origin,connectOrigin,branch}=deploymentFor(target);
 assert.equal(branch,target==='production'?'main':'staging');
 const binding=assertDispatch({...env,TARGET:target,GITHUB_REF:'refs/heads/main'});
 assert.equal(binding.target,target);assert.equal(binding.origin,origin);
 const plan={origin,target,sdkTrust:{release:{cpOrigin:connectOrigin}}};
 const manifest={manifest_version:1,id:'dev.mdbase.editor',homepage:origin+'/',redirect_uris:[origin+'/',origin+'/?server='+encodeURIComponent(connectOrigin)],installation_origins:{[target]:{'app-runtime':[origin]}}};
 assertBuiltManifest(manifest,plan);
 assert.throws(()=>assertBuiltManifest({...manifest,redirect_uris:[origin+'/']},plan));
 const other=target==='production'?'staging':'production';
 assert.throws(()=>assertBuiltManifest({...manifest,installation_origins:{[other]:{'app-runtime':[origin]}}},plan));
});
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'editor-publisher-'));
 const files={'index.html':'<html>editor</html>','404.html':'missing','_headers':headersPolicy,'_redirects':redirectsPolicy,'assets/a.js':'export const value=1;','.well-known/mdbase-app.json':'{}'};
 for(const [path,body] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),body);}
 return {root,files,inventory:await inventoryDirectory(root)};
}
function transport(files,bad=false) {return async url=>{
 const path=new URL(url).pathname;let key=path.slice(1),status=200;
 if(path==='/' || path==='/connect' || path==='/connect/retired')key='index.html';
 if(!(key in files)||key.startsWith('_')){key='404.html';status=404;}
 const headers=new Headers();let section;
 for(const line of headersPolicy.split('\n')){if(line&&!line.startsWith(' '))section=line;const match=/^  ([^:]+): (.+)$/.exec(line);if(section==='/*'&&match)headers.set(match[1],match[2]);}
 if(path.startsWith('/assets/'))headers.set('cache-control','public, max-age=0, must-revalidate');
 if(path==='/.well-known/mdbase-app.json')headers.set('cache-control','no-store');
 headers.set('content-type',key.endsWith('.js')?'application/javascript':key.endsWith('.json')?'application/json':'text/html');
 if(bad)headers.delete('content-security-policy');
 return new Response(files[key],{status,headers});
};}
it('accounts for ALL static bytes plus SOURCE-owned headers/redirects; refuses tamper and wrong live policy',async()=>{
 const f=await fixture();try{
  await assertHostingSource(f.root,f.inventory);
  const report=await verifyHosting({origin,inventory:f.inventory,deployment,fetchImpl:transport(f.files)});
  assert.equal(report.ok,true);assert.equal(report.verified.length+report.controls.length,f.inventory.length);assert.equal(report.unverified.length,0);assert.equal(report.controls.length,2);
  const plan={sha:source,tree,target:'staging',origin,pagesBranch:'staging'};
  const receiptEnv={...env,...hashes,GITHUB_REPOSITORY:expected.repository,GITHUB_REPOSITORY_ID:expected.repositoryId,GITHUB_RUN_ID:expected.run,GITHUB_RUN_ATTEMPT:expected.attempt,ARTIFACT_ID:expected.id,ARTIFACT_DIGEST:expected.digest};
  const verification={...report,origins:[{...report,origin},{...report,origin:deployment.url}]};
  const evidence={plan,inventory:f.inventory,deployment,verification,env:receiptEnv,project:{id:uuid,name:'mdbase-editor',productionBranch:'main'},artifact:{expected,before:metadata,after:metadata,run,runAfter:run,downloadedSha256:expected.digest.slice(7)}};
  assert.equal(createReceipt(evidence).status,'verified');
  assert.equal(createReceipt({...evidence,verification:{...verification,origins:verification.origins.slice(0,1)}}).status,'failed-or-incomplete');
  assert.equal(createReceipt({...evidence,artifact:{...evidence.artifact,runAfter:{...run,run_attempt:2}}}).status,'failed-or-incomplete');
  const badUrls=[],badTransport=transport(f.files,true);
  assert.equal((await verifyHosting({origin,inventory:f.inventory,deployment,fetchImpl:async(...args)=>{badUrls.push(String(args[0]));return badTransport(...args);}})).ok,false);
  assert.equal(new Set(badUrls).size,badUrls.length,'Security-header failures must not be retried as transient transport errors');
  const staleEdge=match=>async(url,init)=>{
   const response=await transport(f.files)(url,init);
   if(!match(new URL(url).pathname,response))return response;
   response.headers.set('content-security-policy',"default-src 'self'");
   return response;
  };
  const staleAsset=staleEdge(path=>path==='/assets/a.js');
  assert.equal((await verifyHosting({origin,inventory:f.inventory,deployment,fetchImpl:staleAsset})).ok,true,'unchanged asset may keep previous headers on the alias');
  const immutableStale=await verifyHosting({origin:deployment.url,inventory:f.inventory,deployment,fetchImpl:staleAsset});
  assert.equal(immutableStale.ok,false,'the immutable URL proves the policy on every file');
  assert.deepEqual(immutableStale.failures.find(x=>x.path==='/assets/a.js'),{path:'/assets/a.js',reason:'trusted-live-header-policy-failed',
   detail:'Live source-owned header policy mismatch: Content-Security-Policy'},'the report names the rule, never the served value');
  const staleDocument=staleEdge((path,response)=>response.headers.get('content-type')==='text/html');
  assert.equal((await verifyHosting({origin,inventory:f.inventory,deployment,fetchImpl:staleDocument})).ok,false,'documents prove the policy on the alias');
  await writeFile(join(f.root,'_headers'),headersPolicy+'# changed\n');
  await assert.rejects(assertHostingSource(f.root,f.inventory),/changed/);
  await assert.rejects(verifyHosting({origin,inventory:[...f.inventory,{path:'nested/_headers',bytes:0,sha256:sha('')}],deployment}),/Unreviewed/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('checks complete immutable directory contents and retains incomplete receipts as failures',async()=>{
 const f=await fixture();try{
  const root=join(f.root,'artifact');await mkdir(root);await mkdir(join(root,'publish'));await writeFile(join(root,'publish','a.txt'),'data');
  const inventory=await inventoryDirectory(join(root,'publish'));
  const plan={sha:source,tree,target:'staging',origin,pagesBranch:'staging',sdkTrust:{environment:'staging'}};
  const contents={'inventory.json':JSON.stringify(inventory),'plan.json':JSON.stringify(plan)};
  for(const [name,bytes] of Object.entries(contents))await writeFile(join(root,name),bytes);
  await writeFile(join(root,'envelope.json'),JSON.stringify({...expected,inventorySha256:sha(contents['inventory.json']),planSha256:sha(contents['plan.json'])}));
  await assertArtifactDirectory(root,expected);
  await writeFile(join(root,'publish','extra'),'not inventoried');await assert.rejects(assertArtifactDirectory(root,expected));
  assert.equal(createReceipt({plan,inventory,deployment}).status,'failed-or-incomplete');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
it('runs main pushes as checks only and isolates build from protected upload dependencies',async()=>{
 const workflow=parse(await readFile(join(repoRoot,'.github/workflows/editor-pages.yml'),'utf8'));
 assert.ok(workflow.on.push.branches.includes('main'));assert.ok(workflow.on.workflow_dispatch.inputs.source_sha);
 assert.equal(workflow.jobs['native-build'].environment,undefined);
 // Native builds have no protected environment: feedback must be explicit public inputs.
 assert.equal(workflow.jobs['native-build'].env.VITE_MDBASE_FEEDBACK_URL,"${{ inputs.target == 'production' && 'https://feedback-api.mdbase.dev/v1/feedback' || 'https://feedback-api-staging.mdbase.dev/v1/feedback' }}");
 assert.equal(workflow.jobs['native-build'].env.VITE_MDBASE_TURNSTILE_SITE_KEY,"${{ inputs.target == 'production' && '0x4AAAAAAEboz_mLT-taI3H-' || '0x4AAAAAAEbkvA4d9vQJq2D1' }}");
 const protectedJob=workflow.jobs['native-deploy'];assert.ok(protectedJob.environment);
 const commands=protectedJob.steps.map(s=>s.run??'').join('\n');
 assert.doesNotMatch(commands,/pnpm (install|build|rebuild)|npm run|npx/);
 assert.doesNotMatch(commands,/CURRENT|release\/native-/);assert.match(commands,/--commit-hash/);assert.match(commands,/--no-bundle/);
 assert.match(workflow.jobs.test.if,/github.event_name != 'workflow_dispatch'/);
 assert.equal(workflow.on.workflow_dispatch.inputs.source_sha.required,true);
 assert.ok(!commands.includes('rollback.mjs recover'));
 assert.doesNotMatch(JSON.stringify(workflow),/NATIVE_(SDK|PROTOCOL|TRUST|UI)_SHA256/);
});
it('re-verifies only the custom alias inside a bounded settle window after the immutable deployment passes',async()=>{
 const plan={sha:source,tree,target:'staging',origin,pagesBranch:'staging'};
 const report=ok=>({ok,verified:[],controls:[],unverified:[],probes:[],failures:ok?[]:[{path:'/',reason:'trusted-live-header-policy-failed'}]});
 const harness=outcomes=>{
  let clock=0;const calls=[],sleeps=[];
  return {calls,sleeps,options:{plan,inventory:[],deployment,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},
   verify:async({origin:target,totalTimeoutMs})=>{calls.push({origin:target,totalTimeoutMs});clock+=1000;return report(outcomes(target,calls.length));}}};
 };
 // Alias still serving the previous deployment twice, then converged.
 const settling=harness((target,n)=>target===deployment.url || n>=4);
 const settled=await verifyPublication(settling.options);
 assert.equal(settled.ok,true);
 assert.deepEqual(settling.calls.map(c=>c.origin),[deployment.url,origin,origin,origin]);
 assert.deepEqual(settling.sleeps,[15000,15000]);
 assert.deepEqual(settled.aliasAttempts.map(a=>a.ok),[false,false,true]);
 assert.equal(settled.aliasAttempts[0].failures[0].reason,'trusted-live-header-policy-failed');
 assert.deepEqual(settled.origins.map(r=>r.origin),[deployment.url,origin],'receipt needs exactly one final report per origin');
 assert.equal(settled.origin,origin);
 // A failing immutable deployment is terminal: one alias report, no settle wait.
 const broken=harness(()=>false);
 const failed=await verifyPublication(broken.options);
 assert.equal(failed.ok,false);assert.equal(broken.calls.length,2);assert.deepEqual(broken.sleeps,[]);
 // An alias that never converges stops inside the window and stays failed.
 const stuck=harness(target=>target===deployment.url);
 const never=await verifyPublication(stuck.options);
 assert.equal(never.ok,false);assert.equal(never.origins.length,2);assert.ok(never.aliasAttempts.length>2);
 assert.ok(stuck.sleeps.reduce((a,b)=>a+b,0)<=300000);
 assert.ok(stuck.calls.every(c=>c.totalTimeoutMs>0 && c.totalTimeoutMs<=180000));
 assert.ok(never.aliasAttempts.at(-1).startedMs<=300000);
 await assert.rejects(verifyPublication({...stuck.options,deployment:{...deployment,sourceSha:'c'.repeat(40)}}),/mismatch/);
});
