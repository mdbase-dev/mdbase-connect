import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { parse } from 'yaml';
import { CONTRACT, CONTRACT_PATH, SELF_HOSTED, assertExistingProject, captureDeployment, createReceipt, headerRules, planned,
  rollback, selfHostedInventory, verifyOrigin, verifyPublication } from './self-hosted.mjs';

const root=new URL('../../../../',import.meta.url).pathname;
const sha='a'.repeat(40),other='b'.repeat(40),account='c'.repeat(32);
const id='11111111-2222-4333-8444-555555555555',previousId='66666666-7777-4888-8999-000000000000';
const policy=await readFile(new URL('../../direct/public/_headers',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=(result,{ok=true,status=200}={})=>({ok,status,json:async()=>({success:ok,result})});

it('the committed source contract opts this Editor into the managed self-hosted target',async()=>{
 assert.deepEqual(JSON.parse(await readFile(join(root,CONTRACT_PATH),'utf8')),{...CONTRACT});
 assert.equal(CONTRACT.origin,'https://editor-self-hosted.mdbase.dev');
 assert.equal(SELF_HOSTED.project,'mdbase-editor-self-hosted');
 assert.ok(headerRules(policy).some(([name,value])=>name==='content-security-policy' && value.includes("frame-ancestors 'none'")));
});

it('plans only a main ancestor carrying the exact contract',async()=>{
 const repo=await mkdtemp(join(tmpdir(),'editor-self-hosted-plan-'));
 const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid'}}).trim();
 try {
  git('init','-q');
  await writeFile(join(repo,'README'),'x');git('add','.');git('commit','-qm','base');
  const without=git('rev-parse','HEAD');
  await mkdir(join(repo,'apps/editor/direct'),{recursive:true});
  await writeFile(join(repo,CONTRACT_PATH),JSON.stringify(CONTRACT));git('add','.');git('commit','-qm','contract');
  const withContract=git('rev-parse','HEAD');
  await writeFile(join(repo,CONTRACT_PATH),JSON.stringify({...CONTRACT,origin:'https://other.example.org'}));git('commit','-qam','changed');
  const changed=git('rev-parse','HEAD');
  git('update-ref','refs/remotes/origin/main',changed);
  assert.equal(planned(without,repo),false);
  assert.equal(planned(withContract,repo),true);
  assert.throws(()=>planned(changed,repo),/contract does not match/);
  git('update-ref','refs/remotes/origin/main',without);
  assert.throws(()=>planned(withContract,repo),/ancestor/);
 }finally{await rm(repo,{recursive:true,force:true});}
});

async function site({headers=policy,entry=`index-x1-${sha.slice(0,12)}.js`,extra={}}={}) {
 const dir=await mkdtemp(join(tmpdir(),'editor-self-hosted-site-'));
 await mkdir(join(dir,'assets'));
 await writeFile(join(dir,'_headers'),headers);
 await writeFile(join(dir,'index.html'),`<!doctype html><head><script type="module" crossorigin src="/assets/${entry}"></script></head>`);
 await writeFile(join(dir,'404.html'),'<!doctype html>missing');
 await writeFile(join(dir,'assets',entry),'export{}');
 for(const [name,body] of Object.entries(extra))await writeFile(join(dir,name),body);
 return dir;
}
it('inventories only a source-bound build with the source-owned headers and no executing controls',async()=>{
 const dirs=[];
 try {
  const good=await site();dirs.push(good);
  const inventory=await selfHostedInventory(good,sha,{policy});
  assert.deepEqual(inventory.map(a=>a.path),['404.html','_headers',`assets/index-x1-${sha.slice(0,12)}.js`,'index.html']);
  for(const [options,pattern] of [[{headers:Buffer.from('/*\n  X: y\n')},/source-owned policy/],[{entry:'index-x1-local.js'},/source-bound entry/],
   [{entry:`index-x1-${other.slice(0,12)}.js`},/source-bound entry/],[{extra:{_redirects:'/* /index.html 200'}},/executing/],[{extra:{'_worker.js':'x'}},/executing/]]) {
   const dir=await site(options);dirs.push(dir);
   await assert.rejects(selfHostedInventory(dir,sha,{policy}),pattern);
  }
 }finally{for(const dir of dirs)await rm(dir,{recursive:true,force:true});}
});

it('checks the existing project by name, production branch and custom domain, read-only',async()=>{
 const seen=[];
 const project={id,name:SELF_HOSTED.project,production_branch:'main',domains:['editor-self-hosted.mdbase.dev']};
 const fetchImpl=async(url,init)=>{seen.push([url,init.method]);return json(project);};
 assert.deepEqual(await assertExistingProject({accountId:account,apiToken:'t',fetchImpl}),
  {id,name:SELF_HOSTED.project,productionBranch:'main',domain:'editor-self-hosted.mdbase.dev'});
 assert.deepEqual(seen,[[`https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/mdbase-editor-self-hosted`,'GET']]);
 for(const changed of [{domains:[]},{production_branch:'preview'},{name:'mdbase-editor'}])
  await assert.rejects(assertExistingProject({accountId:account,apiToken:'t',fetchImpl:async()=>json({...project,...changed})}),/identity\/channel\/domain/);
 await assert.rejects(assertExistingProject({accountId:account,apiToken:'t',fetchImpl:async()=>json(null,{ok:false,status:403})}),/Pages API request failed/);
 await assert.rejects(assertExistingProject({accountId:'x',apiToken:'t',fetchImpl}),/credentials required/);
});

it('captures the exact deployment UUID after list lag, and refuses ambiguity',async()=>{
 const url=`https://abcdef12.${SELF_HOSTED.project}.pages.dev`;
 const output=`Deployment complete! ${url}`;
 const deployment={id,url,deployment_trigger:{metadata:{commit_hash:sha,branch:'main'}}};
 let reads=0;const sleeps=[];
 const fetchImpl=async()=>json(++reads<3?[]:[deployment]);
 assert.deepEqual(await captureDeployment({output,sha,accountId:account,apiToken:'t',fetchImpl,sleep:async ms=>sleeps.push(ms)}),
  {id,url,sourceSha:sha,pagesBranch:'main'});
 assert.deepEqual(sleeps,[5000,10000]);
 await assert.rejects(captureDeployment({output,sha,accountId:account,apiToken:'t',fetchImpl:async()=>json([deployment,{...deployment,id:previousId}]),sleep:async()=>{}}),/mismatch/);
 await assert.rejects(captureDeployment({output,sha,accountId:account,apiToken:'t',fetchImpl:async()=>json([]),sleep:async()=>{}}),/lookup failed/);
 await assert.rejects(captureDeployment({output:'no url',sha}),/unambiguous/);
});

it('verifies every byte and the source-owned headers on served documents',async()=>{
 const dir=await site();
 try {
  const inventory=await selfHostedInventory(dir,sha,{policy});
  const files=Object.fromEntries(await Promise.all(inventory.map(async a=>[a.path,await readFile(join(dir,a.path))])));
  const headers=Object.fromEntries(headerRules(policy));
  const serve=({badHeader=false}={})=>async url=>{
   const path=new URL(url).pathname;
   const name=path==='/'?'index.html':path==='/404'?'404.html':path.slice(1);
   const body=files[name];
   const html=name.endsWith('.html');
   const h=new Headers({'content-type':html?'text/html; charset=utf-8':'text/javascript',...(html?headers:{})});
   if(badHeader && html)h.set('x-frame-options','SAMEORIGIN');
   return new Response(body,{status:body?200:404,headers:h});
  };
  const good=await verifyOrigin({origin:SELF_HOSTED.origin,inventory,policy,fetchImpl:serve()});
  assert.equal(good.ok,true,JSON.stringify(good.failures));
  assert.equal(good.verified.length,inventory.length-1);
  const bad=await verifyOrigin({origin:SELF_HOSTED.origin,inventory,policy,fetchImpl:serve({badHeader:true})});
  assert.equal(bad.ok,false);
  assert.ok(bad.failures.some(f=>f.reason==='trusted-live-header-policy-failed' && f.detail==='header x-frame-options'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('verifies the immutable URL once, then lets only the alias settle',async()=>{
 const deployment={id,url:`https://abcdef12.${SELF_HOSTED.project}.pages.dev`,sourceSha:sha,pagesBranch:'main'};
 let clock=0,aliasReads=0;const origins=[];
 const verify=async({origin})=>{origins.push(origin);if(origin===SELF_HOSTED.origin)aliasReads++;return {origin,ok:origin!==SELF_HOSTED.origin || aliasReads>2};};
 const result=await verifyPublication({sha,inventory:[],deployment,policy,verify,now:()=>clock,sleep:async ms=>{clock+=ms;}});
 assert.equal(result.ok,true);assert.equal(result.aliasAttempts,3);
 assert.deepEqual(origins,[deployment.url,SELF_HOSTED.origin,SELF_HOSTED.origin,SELF_HOSTED.origin]);
 const failed=await verifyPublication({sha,inventory:[],deployment,policy,verify:async({origin})=>({origin,ok:false}),now:()=>0,sleep:async()=>{}});
 assert.equal(failed.ok,false);assert.equal(failed.origins.length,1);
 await assert.rejects(verifyPublication({sha:other,inventory:[],deployment,policy,verify}),/mismatch/);
});

it('restores the recovery point only while this run is the active deployment',async()=>{
 const index='<!doctype html>previous';
 const previous={id:previousId,url:`https://12345678.${SELF_HOSTED.project}.pages.dev`,sourceSha:other,index:{bytes:index.length,sha256:hash(index)}};
 const run=async active=>{
  const calls=[];let current=active;
  const fetchImpl=async(url,init)=>{
   calls.push(init.method??'GET');
   if(url.startsWith(SELF_HOSTED.origin))return new Response(current.id===previousId?index:'new',{status:200});
   if(init.method==='POST'){current={id:previousId};return json({});}
   return json({canonical_deployment:current});
  };
  let clock=0;
  const report=await rollback(previous,{accountId:account,apiToken:'t',fetchImpl},{source:sha,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  return {report,calls};
 };
 const restored=await run({id,deployment_trigger:{metadata:{commit_hash:sha}}});
 assert.equal(restored.report.ok,true);assert.equal(restored.report.restored,true);
 assert.equal(restored.calls.filter(m=>m==='POST').length,1);
 const newer=await run({id,deployment_trigger:{metadata:{commit_hash:other}}});
 assert.equal(newer.report.refused,true);assert.equal(newer.report.ok,false);
 assert.ok(!newer.calls.includes('POST'));
 await assert.rejects(rollback({id:previousId},{},{source:sha}),/captured previous/);
});

it('the receipt is verified only with project, deployment, both origins, every asset and the artifact bound',()=>{
 const inventory=[{path:'_headers',sha256:'1'.repeat(64),bytes:1},{path:'index.html',sha256:'2'.repeat(64),bytes:2}];
 const deployment={id,url:`https://abcdef12.${SELF_HOSTED.project}.pages.dev`,sourceSha:sha,pagesBranch:'main'};
 const report=origin=>({origin,ok:true,verified:[{path:'index.html',sha256:'2'.repeat(64),bytes:2}]});
 const env={ARTIFACT_DIGEST:'sha256:'+'d'.repeat(64)};
 const base={sha,inventory,deployment,env,project:{id,name:SELF_HOSTED.project,productionBranch:'main'},
  verification:{ok:true,origins:[report(deployment.url),report(SELF_HOSTED.origin)]},artifact:{downloadedSha256:'d'.repeat(64)}};
 assert.equal(createReceipt(base).status,'verified');
 for(const change of [{project:null},{deployment:{...deployment,sourceSha:other}},{verification:{ok:true,origins:[report(deployment.url)]}},
  {artifact:{downloadedSha256:'d'.repeat(64),failure:{}}},{inventory:[inventory[0]]}])
  assert.equal(createReceipt({...base,...change}).status,'failed-or-incomplete');
});

it('the self-hosted job runs only after a smoked production publication, with workflow-owned helpers',async()=>{
 const {jobs}=parse(await readFile(join(root,'.github/workflows/editor-pages.yml'),'utf8'));
 const job=jobs['self-hosted'];
 assert.equal(job.name,'Protected immutable self-hosted Editor upload');
 assert.match(job.if,/inputs\.target == 'production'/);assert.match(job.if,/needs\.smoke\.result == 'success'/);
 assert.match(job.if,/needs\.native-build\.outputs\.self-hosted == 'true'/);
 assert.deepEqual(job.environment,{name:'editor-production',deployment:false});
 assert.equal(job.steps[0].run,'test "$GITHUB_RUN_ATTEMPT" = 1');
 const checkouts=job.steps.filter(s=>s.uses?.startsWith('actions/checkout@'));
 assert.equal(checkouts[0].with.ref,'${{ github.sha }}');
 const ancestry=job.steps.findIndex(s=>s.run?.includes('refs.mjs')),candidate=job.steps.findIndex(s=>s.with?.path==='candidate');
 assert.ok(ancestry>0 && ancestry<candidate);
 for(const step of job.steps) {
  assert.notEqual(step['working-directory'],'candidate');
  assert.doesNotMatch(step.run??'',/(?:node|bash|source|import|cd)\s+[^\n]*candidate/);
 }
 const names=job.steps.map(s=>s.name??s.uses);
 const at=name=>names.indexOf(name);
 assert.ok(at('Capture self-hosted recovery point before upload')<at('Recheck immutable inventory and upload once'));
 const upload=job.steps.find(s=>s.id==='upload');
 assert.match(upload.run,/refs\.mjs/);
 assert.match(upload.run,/--project-name mdbase-editor-self-hosted --branch main --commit-hash "\$SOURCE_SHA" --commit-dirty=false/);
 assert.match(job.steps.find(s=>s.name==='Restore the previous self-hosted deployment; keep run failed').if,/^always\(\)/);
 // The managed build never receives the direct origin: the link stays off.
 const build=jobs['native-build'];
 assert.doesNotMatch(JSON.stringify(build.env),/DIRECT_ORIGIN/);
 // Ops skips only this target while its own app line is stopped.
 const workflow=parse(await readFile(join(root,'.github/workflows/editor-pages.yml'),'utf8'));
 assert.deepEqual(workflow.on.workflow_dispatch.inputs.skip_self_hosted,{description:'Skip only the self-hosted Editor target (ops sets this while its app line is stopped).',type:'boolean',default:false});
 const plan=build.steps.find(s=>s.id==='self-hosted');
 assert.equal(plan.env.SKIP_SELF_HOSTED,"${{ inputs.skip_self_hosted && 'true' || 'false' }}");
 assert.match(plan.run,/planned=false\n\s*if \[ "\$SKIP_SELF_HOSTED" != true \]/);
 const managed=jobs['native-deploy'].steps.findIndex(s=>s.name==='Existing self-hosted project identity (never provision)');
 assert.ok(managed>=0 && managed<jobs['native-deploy'].steps.findIndex(s=>s.id==='upload'),'credential scope refuses before any write');
});
