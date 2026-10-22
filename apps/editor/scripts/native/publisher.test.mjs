// Command/data doubles only: no authentication, Cloudflare, Native or Stage IO.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';
import { assertDispatch, assertCurrentHead } from './refs.mjs';
import { loadOriginals, protectedHashes } from './originals.mjs';
import { assertArtifactMetadata, assertArtifactRun, assertArtifactDirectory } from './artifact.mjs';
import { inventoryDirectory } from './native-publish-bytes.mjs';
import { headersPolicy, redirectsPolicy, assertHostingSource, verifyHosting } from './hosting.mjs';
import { assertBuiltManifest, captureDeployment, createReceipt } from './publisher.mjs';
const repoRoot=fileURLToPath(new URL('../../../../',import.meta.url));
const hashes={NATIVE_SDK_SHA256:'15eb64b50fc7c2809ff3dba9cce5104fe48d8592208b3af8acb529862a1af18c',
 NATIVE_UI_SHA256:'8f785294454321c40596bdaad976dc4c5374c3f23dfa828f47e3e7b3139b77e5',
 NATIVE_PROTOCOL_SHA256:'cd1e15236ab7e25c511a4ba13af6a9df23f4b41715161479bba97b0445e1c138',
 NATIVE_TRUST_ASSET_SHA256:'67e117646c9c26927f0d5a44cbd26f057c318975032e9cd24f24b020150cdbc7'};
const source='a'.repeat(40),tree='b'.repeat(40),origin='https://editor-staging.mdbase.dev';
const uuid='12345678-1234-4234-8234-123456789abc';
const env={TARGET:'staging',SOURCE_SHA:source,GITHUB_SHA:source,GITHUB_REF:'refs/heads/release/native-staging',GITHUB_EVENT_NAME:'workflow_dispatch'};
const expected={id:'10',digest:'sha256:'+'c'.repeat(64),repository:'mdbase-dev/mdbase-connect',repositoryId:'20',run:'30',attempt:'1',event:'workflow_dispatch',ref:env.GITHUB_REF,source,tree,target:'staging'};
const metadata={id:10,expired:false,digest:expected.digest,name:'editor-native-build-staging-30-1',workflow_run:{id:30,head_sha:source,head_repository_id:20}};
const run={id:30,head_sha:source,run_attempt:1,event:expected.event,head_branch:'release/native-staging',path:'.github/workflows/editor-pages.yml',repository:{id:20,full_name:expected.repository}};
const deployment={id:uuid,url:'https://12345678.mdbase-editor.pages.dev',sourceSha:source,pagesBranch:'staging'};
const sha=b=>createHash('sha256').update(b).digest('hex');

it('binds the real original Stage packet, frozen lock and ALL installed SDK/UI/protocol members without importing them',async()=>{
 const result=await loadOriginals({target:'staging',repoRoot,hashes,installed:true});
 assert.equal(result.environment,'staging');assert.equal(result.release.cpOrigin,'https://connect-staging.mdbase.dev');
 assert.equal(result.archives.sdk.members,896);assert.equal(result.archives.sdk.sha256,hashes.NATIVE_SDK_SHA256);
 assert.equal(result.release.assetSha256,hashes.NATIVE_TRUST_ASSET_SHA256);
 await assert.rejects(loadOriginals({target:'production',repoRoot,hashes}),/ENOENT|mismatch/);
 await assert.rejects(loadOriginals({target:'staging',repoRoot,hashes:{...hashes,NATIVE_TRUST_ASSET_SHA256:'15e0c28ca828287666dc13cd1ab8cd90caa8f3a4a0036c5fa0eb6f8fbf162d9e'}}),/RAW signed asset/);
 await assert.rejects(loadOriginals({target:'staging',repoRoot,hashes:{...hashes,NATIVE_SDK_SHA256:'0'.repeat(64)}}),/protected archive hash/);
 await assert.rejects(loadOriginals({target:'staging',repoRoot}),/four protected/);
 assert.throws(()=>protectedHashes({}),/four protected/);
});
it('requires exact manual release-ref HEAD, never a tag/main/short/moving source',async()=>{
 assert.equal(assertDispatch(env).sha,source);
 for(const patch of [{SOURCE_SHA:'abcd'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/heads/main'},{GITHUB_SHA:tree},{TARGET:'lab'}])
  assert.throws(()=>assertDispatch({...env,...patch}));
 let calls=0;
 await assertCurrentHead({...env,GITHUB_REPOSITORY:expected.repository,GITHUB_TOKEN:'fixture'},async url=>{
  calls++;assert.equal(url,`https://api.github.com/repos/${expected.repository}/git/ref/heads/release/native-staging`);
  return Response.json({ref:env.GITHUB_REF,object:{type:'commit',sha:source}});
 });assert.equal(calls,1);
 await assert.rejects(assertCurrentHead({...env,GITHUB_REPOSITORY:expected.repository},async()=>Response.json({ref:env.GITHUB_REF,object:{type:'commit',sha:tree}})),/moved/);
});
it('binds immutable artifact metadata AND the exact workflow/run attempt/manual ref',()=>{
 assertArtifactMetadata(metadata,expected);assertArtifactRun(run,expected);
 for(const patch of [{expired:true},{digest:'sha256:'+'d'.repeat(64)},{name:'editor-native-build-staging-30-2'},{workflow_run:{...metadata.workflow_run,head_repository_id:99}}])assert.throws(()=>assertArtifactMetadata({...metadata,...patch},expected));
 for(const patch of [{run_attempt:2},{event:'push'},{head_branch:'main'},{path:'.github/workflows/native-journal.yml'},{head_sha:tree}])assert.throws(()=>assertArtifactRun({...run,...patch},expected));
});
it('uses page20 and resolves only the unique uploaded URL/full source/channel to a FULL UUID',async()=>{
 const entry={id:uuid,url:deployment.url,deployment_trigger:{metadata:{commit_hash:source,branch:'staging'}}};
 const options={output:'Success '+deployment.url,target:'staging',sha:source,accountId:'a'.repeat(32),apiToken:'fixture'};
 const capture=rows=>captureDeployment({...options,fetchImpl:async url=>{assert.match(url,/\/mdbase-editor\/deployments\?per_page=20$/);return Response.json({success:true,result:rows});}});
 assert.deepEqual(await capture([entry]),deployment);
 for(const bad of [{...entry,id:'12345678'},{...entry,url:'https://87654321.mdbase-editor.pages.dev'},
  {...entry,deployment_trigger:{metadata:{commit_hash:tree,branch:'staging'}}},{...entry,deployment_trigger:{metadata:{commit_hash:source,branch:'main'}}}])await assert.rejects(capture([bad]),/UUID/);
 await assert.rejects(capture([entry,entry]),/UUID/);
});
it('retains BOTH configured Editor callbacks and refuses retargeted installations',()=>{
 const plan={origin,target:'staging',sdkTrust:{release:{cpOrigin:'https://connect-staging.mdbase.dev'}}};
 const manifest={manifest_version:1,id:'dev.mdbase.editor',homepage:origin+'/',redirect_uris:[origin+'/',origin+'/?server=https%3A%2F%2Fconnect-staging.mdbase.dev'],installation_origins:{staging:{'app-runtime':[origin]}}};
 assertBuiltManifest(manifest,plan);
 assert.throws(()=>assertBuiltManifest({...manifest,redirect_uris:[origin+'/']},plan));
 assert.throws(()=>assertBuiltManifest({...manifest,installation_origins:{production:{'app-runtime':[origin]}}},plan));
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
 const protectedJob=workflow.jobs['native-deploy'];assert.ok(protectedJob.environment);
 const commands=protectedJob.steps.map(s=>s.run??'').join('\n');
 assert.doesNotMatch(commands,/pnpm (install|build|rebuild)|npm run|npx/);
 assert.match(commands,/refs\.mjs/);assert.match(commands,/--commit-hash/);assert.match(commands,/--no-bundle/);
 assert.match(workflow.jobs.test.if,/source_sha/);
});
