// Production-only self-hosted Editor target of the same immutable publication:
// same run, source, artifact, environment and credentials as the managed upload.
// Dependency-free reviewed source; the candidate is data only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { assertInventory, inventoryDirectory, verifyServedBytes } from './native-publish-bytes.mjs';
import { assertAncestor } from './refs.mjs';

// The direct build bakes its origin in, so project and origin are fixed here,
// never read from the candidate or an environment variable.
export const SELF_HOSTED=Object.freeze({project:'mdbase-editor-self-hosted',origin:'https://editor-self-hosted.mdbase.dev',branch:'main'});
// A source opts in by carrying this file with exactly this content.
export const CONTRACT_PATH='apps/editor/direct/publication.json';
export const CONTRACT=Object.freeze({schema:1,origin:SELF_HOSTED.origin});
const HEADERS_PATH='apps/editor/direct/public/_headers';
const repoRoot=fileURLToPath(new URL('../../../../',import.meta.url));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const deploymentHost=new RegExp(`^https://[a-f0-9]{8,32}\\.${SELF_HOSTED.project}\\.pages\\.dev$`);
const need=(ok,message)=>{if(!ok)throw Error('Self-hosted Editor refusal: '+message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const wait=ms=>new Promise(done=>setTimeout(done,ms));
const blob=(sha,path,root)=>execFileSync('git',['cat-file','blob',`${sha}:${path}`],{cwd:root,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024});

/** True only when the admitted source carries the exact opt-in contract. */
export function planned(sha,root=repoRoot) {
 need(/^[a-f0-9]{40}$/.test(sha??''),'full source SHA required');
 assertAncestor({sha},root);
 let bytes;
 try{bytes=blob(sha,CONTRACT_PATH,root);}catch{return false;}
 let contract;
 try{contract=JSON.parse(bytes.toString('utf8'));}catch{contract=null;}
 need(isDeepStrictEqual(contract,{...CONTRACT}),'source publication contract does not match this publisher');
 return true;
}
/** The candidate's reviewed _headers, read as Git object data. */
export function sourceHeaders(sha,root=repoRoot) {
 need(/^[a-f0-9]{40}$/.test(sha??''),'full source SHA required');
 assertAncestor({sha},root);
 return blob(sha,HEADERS_PATH,root);
}
export function headerRules(policy) {
 const rules=[];let section;
 for(const line of policy.toString('utf8').split('\n')) {
  if(line && !line.startsWith(' ')){section=line.trim();continue;}
  const match=/^\s+([^:]+):\s*(.+)$/.exec(line);
  if(match && section==='/*')rules.push([match[1].trim().toLowerCase(),match[2].trim()]);
 }
 need(rules.some(([name])=>name==='content-security-policy'),'source _headers must carry a CSP');
 return rules;
}
export async function selfHostedInventory(directory,sha,{root=repoRoot,policy=sourceHeaders(sha,root)}={}) {
 const inventory=await inventoryDirectory(directory,{maxFileBytes:25*1024*1024});
 const headers=inventory.find(a=>a.path==='_headers');
 need(headers?.sha256===hash(policy) && headers.bytes===policy.length && (await readFile(join(directory,'_headers'))).equals(policy),'built _headers must be the source-owned policy');
 for(const a of inventory) {
  const name=a.path.split('/').at(-1);
  need(!['_redirects','_routes.json','_worker.js'].includes(name) && !a.path.startsWith('_worker.js/') && !a.path.startsWith('functions/'),'no executing Pages Worker, route or redirect control');
 }
 need(inventory.some(a=>a.path==='index.html'),'index.html required');
 const html=await readFile(join(directory,'index.html'),'utf8');
 const entries=[...html.matchAll(/<script\b[^>]*\ssrc=["']\/(assets\/[\w.-]+-([a-f0-9]{12})\.js)["']/gi)];
 need(entries.length===1 && entries[0][2]===sha.slice(0,12) && inventory.some(a=>a.path===entries[0][1]),'one source-bound entry asset required');
 return inventory;
}
async function pagesApi(path,{accountId,apiToken,fetchImpl=fetch},method='GET') {
 need(/^[a-f0-9]{32}$/.test(accountId??'') && apiToken,'existing account credentials required');
 const response=await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${SELF_HOSTED.project}${path}`,
  {method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${apiToken}`}});
 need(response.ok,'Pages API request failed');
 const body=await response.json();need(body.success,'Pages API refused request');return body.result;
}
/** Read-only: the existing project, its production branch and custom domain. Never provisions. */
export async function assertExistingProject(options) {
 const project=await pagesApi('',options);
 const domain=new URL(SELF_HOSTED.origin).host;
 need(uuid.test(project?.id??'') && project.name===SELF_HOSTED.project && project.production_branch===SELF_HOSTED.branch &&
  Array.isArray(project.domains) && project.domains.includes(domain),'existing approved project identity/channel/domain mismatch');
 return {id:project.id,name:project.name,productionBranch:project.production_branch,domain};
}
async function fingerprint(path,fetchImpl) {
 const response=await fetchImpl(SELF_HOSTED.origin+path,{redirect:'manual',cache:'no-store',credentials:'omit',headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(15000)});
 need(response.status===200,'served index unavailable');
 const bytes=Buffer.from(await response.arrayBuffer());
 need(bytes.length<=2*1024*1024,'served index bound');
 return {bytes:bytes.length,sha256:hash(bytes)};
}
/** The recovery point: canonical deployment and the index bytes it serves, before upload. */
export async function capturePrevious(options) {
 const project=await pagesApi('',options),previous=project.canonical_deployment;
 need(previous?.environment==='production' && uuid.test(previous.id??'') && deploymentHost.test(previous.url??''),'previous production deployment identity required');
 const index=await fingerprint('/',options.fetchImpl??fetch);
 need((await pagesApi('',options)).canonical_deployment?.id===previous.id,'canonical deployment changed during snapshot');
 const commit=previous.deployment_trigger?.metadata?.commit_hash;
 return {id:previous.id,url:previous.url,sourceSha:/^[a-f0-9]{40}$/.test(commit??'')?commit:null,index};
}
export function deploymentPrefix(output) {
 const urls=[...new Set([...output.matchAll(new RegExp(`https://([a-f0-9]{8,32})\\.${SELF_HOSTED.project}\\.pages\\.dev\\b`,'g'))].map(m=>m[1]))];
 need(urls.length===1,'no unambiguous deployment URL');return urls[0];
}
// The deployments list can lag a just-finished upload: re-read (GET only) within a fixed bound.
export const CAPTURE_DELAYS=[5000,10000,15000,30000];
export async function captureDeployment({output,sha,sleep=wait,...options}) {
 need(/^[a-f0-9]{40}$/.test(sha??''),'full source SHA required');
 const url=`https://${deploymentPrefix(output)}.${SELF_HOSTED.project}.pages.dev`;
 for(const delay of [...CAPTURE_DELAYS,null]) {
  let matches=null;
  try {
   const result=await pagesApi('/deployments?per_page=20',options);
   matches=Array.isArray(result)?result.filter(d=>d.url===url && d.deployment_trigger?.metadata?.commit_hash===sha && d.deployment_trigger?.metadata?.branch===SELF_HOSTED.branch):[];
  }catch{/* Transient read; bounded below. */}
  need(!matches || matches.length<=1,'actual deployment UUID/source/channel mismatch');
  if(matches?.length===1) {
   need(uuid.test(matches[0].id??''),'actual deployment UUID/source/channel mismatch');
   return {id:matches[0].id,url,sourceSha:sha,pagesBranch:SELF_HOSTED.branch};
  }
  need(delay!==null,'deployment UUID lookup failed');
  await sleep(delay);
 }
}
/** Every inventory byte at one origin, and the source-owned headers on every HTML document. */
export async function verifyOrigin({origin,inventory,policy,fetchImpl=fetch,totalTimeoutMs=180000}) {
 const rules=headerRules(policy),failures=[];let documents=0;
 const transport=async(url,init)=>{
  const response=await fetchImpl(url,init);
  if(response.status===200 && response.headers.get('content-type')?.includes('text/html')) {
   documents++;
   for(const [name,value] of rules)if(response.headers.get(name)!==value)
    failures.push({path:new URL(url).pathname,reason:'trusted-live-header-policy-failed',detail:'header '+name});
  }
  return response;
 };
 let bytes;
 try{bytes=await verifyServedBytes(origin,inventory,{fetch:transport,totalTimeoutMs});}
 catch(error){bytes={verified:[],unverified:[],failures:[{path:'*',reason:String(error?.message??'verification-failed').slice(0,80)}]};}
 failures.push(...bytes.failures);
 // _headers is never served; it is proven by source equality and the live document headers above.
 const unverified=bytes.unverified.filter(a=>a.path!=='_headers');
 const ok=failures.length===0 && unverified.length===0 && documents>0 && bytes.verified.length===inventory.length-1;
 return {origin,ok,verified:bytes.verified,unverified,failures:failures.slice(0,50),failureCount:failures.length,documents};
}
// The immutable URL is verified once; the alias is then re-verified, read-only,
// inside a settle window while Pages propagates. Nothing is re-uploaded.
export const ALIAS_SETTLE_MS=900000;
export async function verifyPublication({sha,inventory,deployment,policy=sourceHeaders(sha),verify=verifyOrigin,now=()=>performance.now(),sleep=wait,aliasSettleMs=ALIAS_SETTLE_MS,retryMs=30000}) {
 need(deployment?.sourceSha===sha && deployment.pagesBranch===SELF_HOSTED.branch && uuid.test(deployment.id??'') && deploymentHost.test(deployment.url??''),'Deployment/source/channel mismatch');
 const immutable=await verify({origin:deployment.url,inventory,policy});
 const origins=[immutable];let aliasAttempts=0;
 if(immutable.ok) {
  const deadline=now()+aliasSettleMs;let alias;
  for(;;) {
   aliasAttempts++;
   alias=await verify({origin:SELF_HOSTED.origin,inventory,policy,totalTimeoutMs:Math.max(1,Math.min(180000,deadline-now()))});
   if(alias.ok || deadline-now()<retryMs*2)break;
   await sleep(retryMs);
  }
  origins.push(alias);
 }
 return {ok:origins.length===2 && origins.every(r=>r.ok),origins,aliasAttempts};
}
/** Restore the recovery point only while this run's source is the active deployment. */
export async function rollback(previous,options,{source,sleep=wait,now=()=>performance.now(),settleMs=300000}={}) {
 need(uuid.test(previous?.id??'') && /^[a-f0-9]{40}$/.test(source??'') && /^[a-f0-9]{64}$/.test(previous.index?.sha256??''),'captured previous deployment required');
 const report={attempted:true,previousId:previous.id,ok:false,attempts:0,restored:false};
 const deadline=now()+settleMs;let matched=0;
 for(;;) {
  report.attempts++;
  try {
   const active=(await pagesApi('',options)).canonical_deployment;
   if(active?.id!==previous.id) {
    // Only this run's source may be undone; anything else is a newer publication.
    if(active?.deployment_trigger?.metadata?.commit_hash!==source){report.refused=true;return report;}
    await pagesApi(`/deployments/${previous.id}/rollback`,options,'POST');
    report.restored=true;matched=0;
   } else {
    const served=await fingerprint('/',options.fetchImpl??fetch);
    matched=isDeepStrictEqual(served,previous.index)?matched+1:0;
    // Two clean reads fifteen seconds apart: an accepted upload can still become canonical.
    if(matched>=2){report.ok=true;return report;}
   }
  }catch{matched=0;/* Retain public failure state, never API payloads or transport errors. */}
  if(now()+15000>=deadline)return report;
  await sleep(15000);
 }
}
export function createReceipt({sha,inventory=[],project,previous,deployment,verification,rollback,artifact,env=process.env}) {
 const projectBound=uuid.test(project?.id??'') && project.name===SELF_HOSTED.project && project.productionBranch===SELF_HOSTED.branch;
 const deploymentBound=uuid.test(deployment?.id??'') && deployment.sourceSha===sha && deployment.pagesBranch===SELF_HOSTED.branch;
 const covers=report=>report?.ok===true && report.verified?.length===inventory.length-1 &&
  inventory.filter(a=>a.path!=='_headers').every(a=>report.verified.filter(b=>a.path===b.path && a.sha256===b.sha256 && a.bytes===b.bytes).length===1);
 const verified=verification?.ok===true && verification.origins?.length===2 &&
  [deployment?.url,SELF_HOSTED.origin].every(origin=>verification.origins.filter(r=>r.origin===origin && covers(r)).length===1);
 const artifactBound=artifact && !artifact.failure && artifact.downloadedSha256===(env.ARTIFACT_DIGEST??'').replace(/^sha256:/,'');
 return {schema:'mdbase-editor/self-hosted-receipt@1',
  status:projectBound && deploymentBound && verified && inventory.length>1 && artifactBound?'verified':'failed-or-incomplete',
  sourceSha:sha??null,origin:SELF_HOSTED.origin,project:project??null,
  run:{repository:env.GITHUB_REPOSITORY,id:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,event:env.GITHUB_EVENT_NAME,ref:env.GITHUB_REF},
  artifact:{id:env.ARTIFACT_ID??null,digest:env.ARTIFACT_DIGEST??null,bound:Boolean(artifactBound)},
  previous:previous??null,rollback:rollback??null,assets:inventory,deployment:deployment??null,
  verification:verification??{ok:false,reason:'not attempted/available'}};
}
// Name the fixed refusal, or only the error type: never a message that could carry a payload, URL or credential.
function failure(error) {
 const message=String(error?.message??'');
 if(message.startsWith('Self-hosted Editor refusal: '))return message;
 const name=/^[A-Za-z]{1,40}$/.test(error?.name??'')?error.name:'unknown';
 return `Self-hosted Editor operation failed: transport or runtime error (${name})`;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [command,...args]=process.argv.slice(2);
 const json=async path=>JSON.parse(await readFile(path,'utf8'));
 const optional=async path=>{try{return await json(path);}catch{return null;}};
 const options={accountId:process.env.CLOUDFLARE_ACCOUNT_ID,apiToken:process.env.CLOUDFLARE_API_TOKEN};
 const sha=process.env.SOURCE_SHA;
 try {
  if(command==='planned')console.log(String(process.env.TARGET==='production' && planned(sha)));
  else if(command==='inventory')process.stdout.write(JSON.stringify(await selfHostedInventory(args[0],sha),null,2));
  else if(command==='assert-inventory')await assertInventory(args[0],await json(args[1]));
  else if(command==='project')console.log(JSON.stringify(await assertExistingProject(options),null,2));
  else if(command==='snapshot')console.log(JSON.stringify(await capturePrevious(options),null,2));
  else if(command==='capture')console.log(JSON.stringify(await captureDeployment({output:await readFile(args[0],'utf8'),sha,...options}),null,2));
  else if(command==='verify') {
   const dir=resolve(args[0]);
   const result=await verifyPublication({sha,inventory:await json(join(dir,'inventory.json')),deployment:await json(join(dir,'deployment.json'))});
   console.log(JSON.stringify(result,null,2));
   if(!result.ok) {
    for(const report of result.origins)for(const f of report.failures.slice(0,10))console.error(`FAILED ${report.origin}: ${f.path} ${f.reason}`);
    console.error('Self-hosted Editor hosting verification failed.');process.exitCode=1;
   }
  } else if(command==='recover') {
   const dir=resolve(args[0]);
   const report=await rollback(await json(join(dir,'previous.json')),options,{source:sha});
   await writeFile(join(dir,'rollback.json'),JSON.stringify(report,null,2));
   console.error(report.ok?'Self-hosted publication failed or incomplete; previous deployment active and verified':report.refused?'Self-hosted publication failed or incomplete; a different deployment is active, so nothing was restored':'Self-hosted publication failed or incomplete; rollback did not succeed');
   process.exitCode=1;
  } else if(command==='receipt') {
   const dir=resolve(args[0]);
   const receipt=createReceipt({sha,inventory:await optional(join(dir,'inventory.json'))??[],project:await optional(join(dir,'project.json')),
    previous:await optional(join(dir,'previous.json')),deployment:await optional(join(dir,'deployment.json')),
    verification:await optional(join(dir,'verification.json')),rollback:await optional(join(dir,'rollback.json')),artifact:await optional(join(dir,'artifact-metadata.json'))});
   console.log(JSON.stringify(receipt,null,2));if(receipt.status!=='verified')process.exitCode=1;
  } else throw Error('Unknown self-hosted command');
 }catch(error){console.error(failure(error));process.exitCode=1;}
}
